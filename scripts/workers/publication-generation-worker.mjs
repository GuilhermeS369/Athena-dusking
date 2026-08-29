#!/usr/bin/env node

import os from 'node:os';
import fs from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { createAdaptiveBulkController } from './adaptive-bulk-controller.mjs';
import {
  loadPublicationPressureSignal,
  shouldYieldToPublicationPressure,
  shouldForceThroughPublicationPressure,
} from './publication-pressure-signal.mjs';

loadEnvFile('.env.local');
loadEnvFile('.env.worker');

const args = new Set(process.argv.slice(2));
const runOnce = args.has('--once') || process.env.PUBLICATION_GENERATION_WORKER_ONCE === 'true';
const workerId = process.env.PUBLICATION_GENERATION_WORKER_ID || `generation-${os.hostname()}-${process.pid}`;
const mode = process.env.PUBLICATION_GENERATION_WORKER_MODE || 'observe';
const dryRun = process.env.PUBLICATION_GENERATION_WORKER_DRY_RUN !== 'false';
const pollIntervalMs = integerEnv('PUBLICATION_GENERATION_WORKER_POLL_INTERVAL_MS', 10000, 1000, 60000);
const heartbeatIntervalMs = integerEnv('PUBLICATION_GENERATION_WORKER_HEARTBEAT_INTERVAL_MS', 60000, 5000, 300000);
const claimLimit = integerEnv('PUBLICATION_GENERATION_WORKER_LIMIT', 1, 1, 20);
const chunkClaimLimit = integerEnv('PUBLICATION_GENERATION_WORKER_CHUNK_LIMIT', 1, 1, 50);
const leaseSeconds = integerEnv('PUBLICATION_GENERATION_WORKER_LEASE_SECONDS', 300, 60, 3600);
const bulkChunkClaimLimit = integerEnv('PUBLICATION_GENERATION_WORKER_BULK_CHUNK_LIMIT', 1, 1, 50);
const bulkInitialStepSize = integerEnv('PUBLICATION_GENERATION_WORKER_BULK_STEP_SIZE', 50, 25, 100);
const bulkMinStepSize = integerEnv('PUBLICATION_GENERATION_WORKER_BULK_MIN_STEP_SIZE', 25, 25, 50);
const bulkMaxStepSize = integerEnv('PUBLICATION_GENERATION_WORKER_BULK_MAX_STEP_SIZE', 100, 50, 100);
const bulkFastThresholdMs = integerEnv('PUBLICATION_GENERATION_WORKER_BULK_FAST_THRESHOLD_MS', 250, 50, 1000);
const bulkSlowThresholdMs = integerEnv('PUBLICATION_GENERATION_WORKER_BULK_SLOW_THRESHOLD_MS', 750, 250, 5000);
const bulkFastPerItemThresholdMs = integerEnv('PUBLICATION_GENERATION_WORKER_BULK_FAST_PER_ITEM_THRESHOLD_MS', 25, 5, 100);
const bulkMaxStableDurationMs = integerEnv('PUBLICATION_GENERATION_WORKER_BULK_MAX_STABLE_DURATION_MS', 3000, 750, 10000);
const bulkStableSlicesRequired = integerEnv('PUBLICATION_GENERATION_WORKER_BULK_STABLE_SLICES_REQUIRED', 5, 2, 20);
const bulkTimeoutCooldownMs = integerEnv('PUBLICATION_GENERATION_WORKER_BULK_TIMEOUT_COOLDOWN_MS', 120000, 10000, 600000);
const bulkIdleCooldownMs = integerEnv('PUBLICATION_GENERATION_WORKER_BULK_IDLE_COOLDOWN_MS', 30000, 5000, 300000);
const bulkMaxFailures = integerEnv('PUBLICATION_GENERATION_WORKER_BULK_MAX_FAILURES', 3, 1, 20);
export function bulkGenerationIsEnabled(value = process.env.PUBLICATION_GENERATION_WORKER_BULK_ENABLED) {
  return String(value ?? 'true').trim().toLowerCase() !== 'false';
}
const bulkGenerationEnabled = bulkGenerationIsEnabled();

const criticalDelayForceAfterMs = integerEnv(
  'PUBLICATION_GENERATION_WORKER_CRITICAL_DELAY_FORCE_AFTER_MS',
  300000,
  60000,
  1800000,
);

let stopping = false;
let lastHeartbeatAt = 0;
// Marca quando a série atual de "geração cedeu ao atraso crítico" começou; null quando não
// está cedendo. Mesma rede de segurança de shouldForceThroughPublicationPressure usada pelo
// staging (ver plans/plano-correcao-deadlock-staging-criticaldelay-2026-08-28.md).
let criticalDelayYieldStreakStartedAt = null;
let forcedThroughCriticalDelayCount = 0;

const adaptiveBulkController = createAdaptiveBulkController({
  initialStep: bulkInitialStepSize,
  minimumStep: bulkMinStepSize,
  maximumStep: bulkMaxStepSize,
  fastThresholdMs: bulkFastThresholdMs,
  slowThresholdMs: bulkSlowThresholdMs,
  fastPerItemThresholdMs: bulkFastPerItemThresholdMs,
  maxStableDurationMs: bulkMaxStableDurationMs,
  stableSlicesRequired: bulkStableSlicesRequired,
  timeoutCooldownMs: bulkTimeoutCooldownMs,
  idleCooldownMs: bulkIdleCooldownMs,
});

process.on('SIGINT', () => {
  stopping = true;
});
process.on('SIGTERM', () => {
  stopping = true;
});

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    if (process.env[key]) continue;
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

function integerEnv(name, fallback, minimum, maximum) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSupabase() {
  return createClient(requiredEnv('NEXT_PUBLIC_SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function summarizeJobs(rows) {
  return rows.reduce((summary, row) => {
    summary.total += 1;
    summary.expectedItems += row.expected_items || 0;
    summary.generatedItems += row.generated_items || 0;
    summary.failedItems += row.failed_items || 0;
    summary.byStatus[row.status] = (summary.byStatus[row.status] || 0) + 1;
    return summary;
  }, { total: 0, expectedItems: 0, generatedItems: 0, failedItems: 0, byStatus: {} });
}

async function heartbeat(supabase, status, metadata = {}, lastErrorMessage = null) {
  const { error } = await supabase.rpc('upsert_publication_worker_heartbeat', {
    p_worker_id: workerId,
    p_worker_kind: 'publication_planner',
    p_status: status,
    p_dry_run: dryRun,
    p_version: process.env.npm_package_version || null,
    p_hostname: os.hostname(),
    p_process_id: process.pid,
    p_last_error_message: lastErrorMessage,
    p_metadata: {
      mode,
      runOnce,
      pollIntervalMs,
      heartbeatIntervalMs,
      claimLimit,
      chunkClaimLimit,
      leaseSeconds,
      bulkChunkClaimLimit,
      bulkStepSize: adaptiveBulkController.snapshot().currentStep,
      bulkInitialStepSize,
      bulkMinStepSize,
      bulkMaxStepSize,
      bulkFastThresholdMs,
      bulkSlowThresholdMs,
      bulkTimeoutCooldownMs,
      adaptiveBulk: adaptiveBulkController.snapshot(),
      bulkMaxFailures,
      bulkGenerationEnabled,
      ...metadata,
    },
  });
  if (error) throw error;
  lastHeartbeatAt = Date.now();
}

async function loadJobSummary(supabase) {
  const { data, error } = await supabase
    .from('publication_generation_jobs')
    .select('id, status, expected_items, generated_items, failed_items, chunk_size, chunk_count, created_at, updated_at')
    .in('status', ['queued', 'processing', 'paused', 'failed'])
    .order('created_at', { ascending: true })
    .limit(1000);
  if (error) throw error;
  return data || [];
}

export async function loadBulkSummary(supabase) {
  const { data, error } = await supabase.rpc('get_bulk_rotation_worker_summary');
  if (error) throw error;
  return data || {};
}

function estimateChunks(job) {
  const expectedItems = job.expected_items || 0;
  const chunkSize = job.chunk_size || 500;
  return expectedItems > 0 ? Math.ceil(expectedItems / chunkSize) : 0;
}

async function claimJobs(supabase) {
  const { data, error } = await supabase.rpc('claim_publication_generation_jobs', {
    p_worker_id: workerId,
    p_limit: claimLimit,
    p_lease_seconds: leaseSeconds,
  });
  if (error) throw error;
  return data || [];
}

async function releaseClaimedJobAsPaused(supabase, job, message, metadata = {}) {
  const { error } = await supabase.rpc('complete_publication_generation_job', {
    p_job_id: job.id,
    p_worker_id: workerId,
    p_status: 'paused',
    p_generated_items: job.generated_items || 0,
    p_failed_items: job.failed_items || 0,
    p_error_message: message,
    p_metadata: metadata,
  });
  if (error) throw error;
}

async function materializeJob(supabase, job) {
  const { data, error } = await supabase.rpc('materialize_publication_generation_job', {
    p_job_id: job.id,
    p_worker_id: workerId,
  });
  if (error) throw error;
  return data;
}

async function claimChunks(supabase) {
  const { data, error } = await supabase.rpc('claim_publication_generation_job_chunks', {
    p_worker_id: workerId,
    p_limit: chunkClaimLimit,
    p_lease_seconds: leaseSeconds,
  });
  if (error) throw error;
  return data || [];
}

async function processChunk(supabase, chunk) {
  const { data, error } = await supabase.rpc('process_publication_generation_chunk', {
    p_chunk_id: chunk.id,
    p_worker_id: workerId,
  });
  if (error) throw error;
  return data;
}

export async function claimBulkChunks(supabase) {
  const { data, error } = await supabase.rpc('claim_bulk_rotation_generation_chunks', {
    p_worker_id: workerId,
    p_limit: bulkChunkClaimLimit,
    p_lease_seconds: leaseSeconds,
    p_max_failures: bulkMaxFailures,
  });
  if (error) throw error;
  return data || [];
}

export async function processBulkChunk(supabase, chunk, stepSize = adaptiveBulkController.snapshot().currentStep) {
  const { data, error } = await supabase.rpc('process_bulk_rotation_generation_chunk', {
    p_chunk_id: chunk.id,
    p_worker_id: workerId,
    p_step_size: stepSize,
  });
  if (error) throw error;
  return data;
}

export async function failBulkChunk(supabase, chunk, message) {
  const { data, error } = await supabase.rpc('fail_bulk_rotation_generation_chunk', {
    p_chunk_id: chunk.id,
    p_worker_id: workerId,
    p_error_message: message,
    p_max_failures: bulkMaxFailures,
  });
  if (error) throw error;
  return data;
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return String(error);
}

export async function processClaimedBulkChunk(supabase, chunk, options = {}) {
  const startedAt = Date.now();
  try {
    const result = await processBulkChunk(supabase, chunk, options.stepSize);
    return { chunkId: chunk.id, ok: true, durationMs: Date.now() - startedAt, result };
  } catch (error) {
    const message = errorMessage(error);
    console.error('[publication-generation-worker] falha em chunk compacto', {
      workerId,
      chunkId: chunk.id,
      planId: chunk.plan_id,
      message,
    });

    try {
      const failure = await failBulkChunk(supabase, chunk, message);
      return { chunkId: chunk.id, ok: false, durationMs: Date.now() - startedAt, message, failure };
    } catch (failureError) {
      const failureMessage = errorMessage(failureError);
      console.error('[publication-generation-worker] falha ao liberar chunk compacto', {
        workerId,
        chunkId: chunk.id,
        planId: chunk.plan_id,
        message: failureMessage,
      });
      return {
        chunkId: chunk.id,
        ok: false,
        durationMs: Date.now() - startedAt,
        message,
        failureRegistrationError: failureMessage,
      };
    }
  }
}

export async function tick(supabase) {
  const [rows, initialBulkSummary] = await Promise.all([
    loadJobSummary(supabase),
    loadBulkSummary(supabase),
  ]);
  const summary = { ...summarizeJobs(rows), bulk: initialBulkSummary };

  if (mode === 'observe' || dryRun) {
    console.info('[publication-generation-worker] observação', { workerId, dryRun, summary });
    return { status: 'observing', summary };
  }

  if (mode !== 'plan') throw new Error(`Modo de worker de geração não suportado nesta etapa: ${mode}`);

  const claimed = await claimJobs(supabase);
  const materialized = [];
  for (const job of claimed) {
    const chunkCount = estimateChunks(job);
    if (mode === 'plan-paused') {
      const message = 'Job reivindicado e pausado com segurança antes da expansão em chunks.';
      await releaseClaimedJobAsPaused(supabase, job, message, { dryLimitedPlanner: true, estimatedChunkCount: chunkCount });
      materialized.push({ jobId: job.id, expectedItems: job.expected_items, chunkSize: job.chunk_size, estimatedChunkCount: chunkCount, status: 'paused' });
      continue;
    }

    const result = await materializeJob(supabase, job);
    materialized.push({ jobId: job.id, expectedItems: job.expected_items, chunkSize: job.chunk_size, estimatedChunkCount: chunkCount, status: 'materialized', result });
  }

  const chunks = await claimChunks(supabase);
  const processedChunks = [];
  for (const chunk of chunks) {
    processedChunks.push(await processChunk(supabase, chunk));
  }

  let heavyLeaseToken = null;
  let pressureSignal = { criticalDelay: false, overdueAccepted: null, overdueUnstarted: null, oldestDueAt: null, checkedAt: null };
  let yieldingToPressure = false;
  const adaptiveBefore = adaptiveBulkController.snapshot();
  if (bulkGenerationEnabled && adaptiveBulkController.canRun()) {
    pressureSignal = await loadPublicationPressureSignal(supabase, 60);
    yieldingToPressure = shouldYieldToPublicationPressure(pressureSignal);
    if (yieldingToPressure) {
      const now = Date.now();
      const forceThrough = shouldForceThroughPublicationPressure(
        criticalDelayYieldStreakStartedAt, now, criticalDelayForceAfterMs,
      );
      if (forceThrough) {
        forcedThroughCriticalDelayCount += 1;
        console.warn('[publication-generation-worker] geração forçada apesar de atraso crítico: teto de segurança atingido', {
          streakMs: now - criticalDelayYieldStreakStartedAt,
          thresholdMs: criticalDelayForceAfterMs,
          pressureSignal,
          forcedThroughCriticalDelayCount,
        });
        yieldingToPressure = false;
        criticalDelayYieldStreakStartedAt = null;
      } else {
        if (criticalDelayYieldStreakStartedAt == null) criticalDelayYieldStreakStartedAt = now;
        adaptiveBulkController.markCriticalDelay();
      }
    } else {
      criticalDelayYieldStreakStartedAt = null;
    }
  }
  if (bulkGenerationEnabled && adaptiveBulkController.canRun() && !yieldingToPressure) {
    const { data, error } = await supabase.rpc('acquire_operational_heavy_workload_lease', {
      p_category: 'bulk_generation',
      p_holder: workerId,
      p_organization_id: null,
      p_lease_seconds: 120,
    });
    if (error) throw error;
    heavyLeaseToken = data;
  }
  const bulkChunks = heavyLeaseToken ? await claimBulkChunks(supabase) : [];
  const processedBulkChunks = [];
  try {
    for (const chunk of bulkChunks) {
      const stepSize = adaptiveBulkController.snapshot().currentStep;
      const processed = await processClaimedBulkChunk(supabase, chunk, { stepSize });
      processedBulkChunks.push(processed);
      adaptiveBulkController.observe({
        durationMs: processed.durationMs,
        ok: processed.ok,
        message: processed.message,
        processedItems: processed.result?.processedItems,
        criticalDelay: pressureSignal.criticalDelay,
      });
    }
  } finally {
    if (heavyLeaseToken) {
      const { error } = await supabase.rpc('release_operational_heavy_workload_lease', {
        p_lease_token: heavyLeaseToken,
      });
      if (error) console.error('[publication-generation-worker] falha ao liberar capacidade pesada', errorMessage(error));
    }
  }
  if (heavyLeaseToken && bulkChunks.length === 0) adaptiveBulkController.markIdle();
  summary.bulk = await loadBulkSummary(supabase);

  const compactActivity = {
    enabled: bulkGenerationEnabled,
    claimedChunks: bulkChunks.length,
    successfulChunks: processedBulkChunks.filter((result) => result.ok).length,
    failedChunks: processedBulkChunks.filter((result) => !result.ok).length,
    waitingForCapacity: bulkGenerationEnabled && !heavyLeaseToken,
    pressureSignal,
    yieldingToPressure,
    forcedThroughCriticalDelayCount,
    adaptiveBefore,
    adaptiveAfter: adaptiveBulkController.snapshot(),
    lastChunk: processedBulkChunks.at(-1) || null,
  };

  console.info('[publication-generation-worker] processamento controlado concluído', {
    workerId,
    claimedJobs: claimed.length,
    materialized,
    claimedChunks: chunks.length,
    processedChunks,
    compactActivity,
    summary,
  });
  return { status: 'processing', summary, materialized, processedChunks, compactActivity };
}

async function main() {
  const supabase = createSupabase();
  console.info('[publication-generation-worker] iniciando', { workerId, mode, dryRun, runOnce });
  await heartbeat(supabase, 'starting');

  while (!stopping) {
    try {
      const result = await tick(supabase);
      if (Date.now() - lastHeartbeatAt >= heartbeatIntervalMs) {
        await heartbeat(supabase, result.status, {
          summary: result.summary,
          compactActivity: result.compactActivity || null,
        });
      }
    } catch (error) {
      const message = errorMessage(error);
      console.error('[publication-generation-worker] falha no ciclo', { workerId, message, error });
      await heartbeat(supabase, 'error', {}, message).catch((heartbeatError) => {
        console.error('[publication-generation-worker] falha ao registrar heartbeat de erro', heartbeatError);
      });
    }

    if (runOnce) break;
    await sleep(pollIntervalMs);
  }

  await heartbeat(supabase, 'stopped').catch((error) => {
    console.error('[publication-generation-worker] falha ao registrar parada', error);
  });
  console.info('[publication-generation-worker] finalizado', { workerId });
}

const executedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (executedDirectly) {
  main().catch((error) => {
    console.error('[publication-generation-worker] erro fatal', error);
    process.exitCode = 1;
  });
}
