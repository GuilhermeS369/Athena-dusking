#!/usr/bin/env node

import os from 'node:os';
import fs from 'node:fs';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { dispatchPublicationQueueDirect, flushZernioRequestTelemetry } from './publication-direct-dispatch.mjs';

loadEnvFile('.env.local');
loadEnvFile('.env.worker');

const args = new Set(process.argv.slice(2));
const runOnce = args.has('--once') || process.env.PUBLICATION_WORKER_ONCE === 'true';
const workerId = process.env.PUBLICATION_WORKER_ID || `publication-${os.hostname()}-${process.pid}`;
const mode = process.env.PUBLICATION_WORKER_MODE || 'observe';
const dryRun = process.env.PUBLICATION_WORKER_DRY_RUN !== 'false';
const pollIntervalMs = integerEnv('PUBLICATION_WORKER_POLL_INTERVAL_MS', 5000, 500, 60000);
const heartbeatIntervalMs = integerEnv('PUBLICATION_WORKER_HEARTBEAT_INTERVAL_MS', 30000, 5000, 300000);
const dispatchLimit = integerEnv('PUBLICATION_WORKER_LIMIT', 5, 1, 100);
const preparationLimit = integerEnv('PUBLICATION_WORKER_PREPARATION_LIMIT', 100, 1, 500);
const leaseSeconds = integerEnv('PUBLICATION_WORKER_LEASE_SECONDS', 180, 30, 900);
const coordinatedRecoveryLimit = integerEnv('PUBLICATION_WORKER_COORDINATED_RECOVERY_LIMIT', 0, 0, 100);

let stopping = false;
let lastHeartbeatAt = 0;

process.on('SIGINT', () => {
  stopping = true;
});
process.on('SIGTERM', () => {
  stopping = true;
});

function integerEnv(name, fallback, minimum, maximum) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function queueTotals(rows) {
  return rows.reduce((summary, row) => {
    summary.total += row.total || 0;
    summary.expiredLeases += row.expired_leases || 0;
    summary.dueRetries += row.due_retries || 0;
    summary.overdue += row.overdue || 0;
    summary.byStatus[row.status] = (summary.byStatus[row.status] || 0) + (row.total || 0);
    return summary;
  }, { total: 0, expiredLeases: 0, dueRetries: 0, overdue: 0, byStatus: {} });
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const details = error;
    const message = typeof details.message === 'string' ? details.message : null;
    const code = typeof details.code === 'string' ? details.code : null;
    const hint = typeof details.hint === 'string' ? details.hint : null;
    const combined = [code, message, hint].filter(Boolean).join(': ');
    if (combined) return combined.slice(0, 1200);
    try {
      return JSON.stringify(details).slice(0, 1200);
    } catch {
      return 'Erro não serializável no worker de publicação.';
    }
  }
  return String(error);
}

function createSupabase() {
  return createClient(
    requiredEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

async function heartbeat(supabase, status, metadata = {}, lastErrorMessage = null) {
  const { error } = await supabase.rpc('upsert_publication_worker_heartbeat', {
    p_worker_id: workerId,
    p_worker_kind: 'publication',
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
      dispatchLimit,
      preparationLimit,
      leaseSeconds,
      ...metadata,
    },
  });
  if (error) throw error;
  lastHeartbeatAt = Date.now();
}

async function loadSummary(supabase) {
  const { data, error } = await supabase.rpc('get_publication_queue_operational_summary', {
    p_organization_id: null,
  });
  if (error) throw error;
  return data || [];
}

async function dispatchThroughEndpoint() {
  const baseUrl = process.env.PUBLICATION_WORKER_APP_BASE_URL?.replace(/\/$/, '');
  const secret = process.env.PUBLICATION_WORKER_SECRET;
  if (!baseUrl) throw new Error('PUBLICATION_WORKER_APP_BASE_URL é obrigatório no modo dispatch-endpoint.');
  if (!secret) throw new Error('PUBLICATION_WORKER_SECRET é obrigatório no modo dispatch-endpoint.');

  const response = await fetch(`${baseUrl}/api/internal/publication-dispatch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-publication-worker-secret': secret,
    },
    body: JSON.stringify({ workerId, limit: dispatchLimit, leaseSeconds }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Dispatcher retornou HTTP ${response.status}.`);
  return payload;
}

async function recordCycleEvent(supabase, payload) {
  const { error } = await supabase.rpc('record_publication_worker_cycle_event', {
    p_correlation_id: payload.correlationId,
    p_worker_id: workerId,
    p_phase: payload.phase,
    p_started_at: payload.startedAt,
    p_completed_at: payload.completedAt ?? null,
    p_metadata: payload.metadata ?? {},
    p_error_code: payload.errorCode ?? null,
    p_error_message: payload.errorMessage ?? null,
  });
  if (error) throw error;
}

// Os eventos de ciclo são telemetria agregada: nunca persistem IDs, URLs,
// tokens, mídia ou a lista de itens processados. O histórico individual da
// fila continua sendo responsabilidade de publication_item_events.
function summarizeDispatch(dispatch) {
  if (!dispatch || typeof dispatch !== 'object') return null;

  const outcomes = (Array.isArray(dispatch.processed) ? dispatch.processed : []).reduce((summary, item) => {
    const state = typeof item?.state === 'string' ? item.state : 'unknown';
    summary[state] = (summary[state] || 0) + 1;
    return summary;
  }, {});

  return {
    claimed: Number.isInteger(dispatch.claimed) ? dispatch.claimed : 0,
    outcomes,
    recovery: dispatch.recovery && typeof dispatch.recovery === 'object'
      ? {
        scanned: Number(dispatch.recovery.scanned || 0),
        rescheduled: Number(dispatch.recovery.rescheduled || 0),
        requiresAttention: Number(dispatch.recovery.requiresAttention || 0),
        bulkSlotsAtRisk: Number(dispatch.recovery.bulkSlotsAtRisk || 0),
        overdueAlerts: Number(dispatch.recovery.overdueAlerts || 0),
      }
      : null,
    preparation: dispatch.preparation && typeof dispatch.preparation === 'object'
      ? {
        claimed: Number(dispatch.preparation.claimed || 0),
        ready: Number(dispatch.preparation.ready || 0),
        blocked: Number(dispatch.preparation.blocked || 0),
        errors: Number(dispatch.preparation.errors || 0),
      }
      : null,
    adaptiveConcurrency: dispatch.adaptiveConcurrency ?? null,
    coordinatedRecovery: dispatch.coordinatedRecovery && typeof dispatch.coordinatedRecovery === 'object'
      ? {
        claimed: Number(dispatch.coordinatedRecovery.claimed || 0),
        finalized: Number(dispatch.coordinatedRecovery.finalized || 0),
      }
      : null,
    recyclingProcessed: Array.isArray(dispatch.recycling) ? dispatch.recycling.length : 0,
  };
}

async function tick(supabase, correlationId) {
  const rows = await loadSummary(supabase);
  const totals = queueTotals(rows);

  if (mode === 'observe' || dryRun) {
    console.info('[publication-worker] observação', { workerId, dryRun, totals });
    return { status: 'observing', totals };
  }

  if (mode === 'dispatch-endpoint') {
    const dispatch = await dispatchThroughEndpoint();
    console.info('[publication-worker] dispatch remoto concluído', { workerId, dispatch, totals });
    return { status: 'dispatching', totals, dispatch };
  }

  if (mode === 'direct' || mode === 'direct-dispatch') {
    const dispatch = await dispatchPublicationQueueDirect({
      workerId,
      limit: dispatchLimit,
      leaseSeconds,
      preparationLimit,
      correlationId,
      recoveryLimit: coordinatedRecoveryLimit,
    });
    console.info('[publication-worker] dispatch direto concluído', { workerId, dispatch, totals });
    return { status: 'dispatching', totals, dispatch };
  }

  throw new Error(`Modo de worker não suportado nesta etapa: ${mode}`);
}

async function main() {
  const supabase = createSupabase();
  console.info('[publication-worker] iniciando', { workerId, mode, dryRun, runOnce });
  await heartbeat(supabase, 'starting');

  while (!stopping) {
    const correlationId = randomUUID();
    const startedAt = new Date().toISOString();
    try {
      await recordCycleEvent(supabase, {
        correlationId,
        phase: 'started',
        startedAt,
        metadata: { mode, dryRun, pollIntervalMs, dispatchLimit, leaseSeconds },
      });
      const result = await tick(supabase, correlationId);
      // Telemetria é auxiliar: não aguardamos e nunca deixamos falha dela interromper a fila.
      void flushZernioRequestTelemetry().catch((telemetryError) => {
        console.error('[publication-worker] falha não bloqueante na telemetria Zernio', telemetryError);
      });
      await recordCycleEvent(supabase, {
        correlationId,
        phase: 'completed',
        startedAt,
        completedAt: new Date().toISOString(),
        metadata: { totals: result.totals, dispatch: summarizeDispatch(result.dispatch) },
      });
      if (Date.now() - lastHeartbeatAt >= heartbeatIntervalMs) {
        await heartbeat(supabase, result.status, { totals: result.totals });
      }
    } catch (error) {
      const message = errorMessage(error);
      console.error('[publication-worker] falha no ciclo', { workerId, message, error });
      await recordCycleEvent(supabase, {
        correlationId,
        phase: 'failed',
        startedAt,
        completedAt: new Date().toISOString(),
        metadata: { mode, dryRun, pollIntervalMs, dispatchLimit, leaseSeconds },
        errorCode: typeof error?.code === 'string' ? error.code : 'publication_worker_cycle_failed',
        errorMessage: message,
      }).catch((eventError) => console.error('[publication-worker] falha ao registrar evento de ciclo', eventError));
      await heartbeat(supabase, 'error', {}, message).catch((heartbeatError) => {
        console.error('[publication-worker] falha ao registrar heartbeat de erro', heartbeatError);
      });
    }

    if (runOnce) break;
    await sleep(pollIntervalMs);
  }

  await heartbeat(supabase, 'stopped').catch((error) => {
    console.error('[publication-worker] falha ao registrar parada', error);
  });
  console.info('[publication-worker] finalizado', { workerId });
}

main().catch((error) => {
  console.error('[publication-worker] erro fatal', error);
  process.exitCode = 1;
});
