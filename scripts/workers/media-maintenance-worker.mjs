#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

loadEnvFile('.env.local');
loadEnvFile('.env.worker');

const args = new Set(process.argv.slice(2));
const runOnce = args.has('--once') || process.env.MEDIA_MAINTENANCE_WORKER_ONCE === 'true';
const workerId = process.env.MEDIA_MAINTENANCE_WORKER_ID || `media-maintenance-${os.hostname()}-${process.pid}`;
const appBaseUrl = requiredEnv('PUBLICATION_WORKER_APP_BASE_URL').replace(/\/$/, '');
const workerSecret = process.env.MEDIA_DELETION_WORKER_SECRET || process.env.PUBLICATION_WORKER_SECRET || process.env.CRON_SECRET;
const pollIntervalMs = integerEnv('MEDIA_MAINTENANCE_WORKER_POLL_INTERVAL_MS', 5000, 500, 60000);
const heartbeatIntervalMs = integerEnv('MEDIA_MAINTENANCE_WORKER_HEARTBEAT_INTERVAL_MS', 60000, 5000, 300000);
const deletionLimit = integerEnv('MEDIA_DELETION_WORKER_LIMIT', 3, 1, 10);
const deletionChunkSize = integerEnv('MEDIA_DELETION_WORKER_CHUNK_SIZE', 50, 1, 100);
const groupAssignmentLimit = integerEnv('MEDIA_GROUP_ASSIGNMENT_WORKER_LIMIT', 3, 1, 10);
const groupAssignmentChunkSize = integerEnv('MEDIA_GROUP_ASSIGNMENT_WORKER_CHUNK_SIZE', 500, 1, 1000);
const leaseSeconds = integerEnv('MEDIA_MAINTENANCE_WORKER_LEASE_SECONDS', 180, 30, 900);
// Arquivamento recorrente de itens encerrados. Antes disso, dependia de alguem
// clicar "Limpar encerradas" na tela: em 29/08/2026 havia 212 mil itens
// encerrados com archived_at nulo, engordando os ~20 indices de
// publication_items — que precisam caber em RAM e eram a causa direta da
// memoria do Supabase em 84%.
const archiveEnabled = (process.env.MEDIA_MAINTENANCE_ARCHIVE_ENABLED || 'true') !== 'false';
const archiveIntervalMs = integerEnv('MEDIA_MAINTENANCE_ARCHIVE_INTERVAL_MS', 600000, 60000, 3600000);
// Orcamento por ciclo, para o arquivamento nunca competir com a publicacao.
const archiveBudgetMs = integerEnv('MEDIA_MAINTENANCE_ARCHIVE_BUDGET_MS', 20000, 1000, 120000);

let lastArchiveAt = 0;

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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
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

function createSupabase() {
  return createClient(requiredEnv('NEXT_PUBLIC_SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function heartbeat(supabase, status, metadata = {}, lastErrorMessage = null) {
  const { error } = await supabase.rpc('upsert_publication_worker_heartbeat', {
    p_worker_id: workerId,
    p_worker_kind: 'media_deletion',
    p_status: status,
    p_dry_run: false,
    p_version: process.env.npm_package_version || null,
    p_hostname: os.hostname(),
    p_process_id: process.pid,
    p_last_error_message: lastErrorMessage,
    p_metadata: {
      runOnce,
      appBaseUrl,
      pollIntervalMs,
      heartbeatIntervalMs,
      deletionLimit,
      deletionChunkSize,
      groupAssignmentLimit,
      groupAssignmentChunkSize,
      leaseSeconds,
      ...metadata,
    },
  });
  if (error) throw error;
  lastHeartbeatAt = Date.now();
}

// A RPC clean_publication_queue_finished processa no maximo 250 itens por
// chamada (teto imposto pela migration 302 como controle de pressao) — pedir
// mais e cortado em silencio. Por isso o laco chama varias vezes dentro de um
// orcamento de tempo, em vez de tentar um lote grande.
async function archiveFinishedItems(supabase) {
  const startedAt = Date.now();
  const { data: organizations, error } = await supabase.from('organizations').select('id, name');
  if (error) throw error;

  let archived = 0;
  let organizationsTouched = 0;
  let exhaustedBudget = false;

  for (const organization of organizations || []) {
    let organizationArchived = 0;
    while (Date.now() - startedAt < archiveBudgetMs) {
      const { data, error: cleanError } = await supabase.rpc('clean_publication_queue_finished', {
        p_organization_id: organization.id,
        p_limit: 250,
      });
      if (cleanError) {
        console.error('[media-maintenance-worker] falha ao arquivar encerrados', {
          organization: organization.name,
          message: cleanError.message,
        });
        break;
      }
      const row = Array.isArray(data) ? data[0] : data;
      const moved = (row?.archived_completed_count || 0) + (row?.archived_failure_count || 0);
      if (moved === 0) break;
      organizationArchived += moved;
    }
    if (organizationArchived > 0) organizationsTouched += 1;
    archived += organizationArchived;
    if (Date.now() - startedAt >= archiveBudgetMs) {
      exhaustedBudget = true;
      break;
    }
  }

  return { archived, organizationsTouched, exhaustedBudget, durationMs: Date.now() - startedAt };
}

async function tick() {
  if (!workerSecret) throw new Error('MEDIA_DELETION_WORKER_SECRET, PUBLICATION_WORKER_SECRET ou CRON_SECRET é obrigatório.');

  const response = await fetch(`${appBaseUrl}/api/internal/media-deletion-dispatch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-media-deletion-worker-secret': workerSecret,
    },
    body: JSON.stringify({
      workerId,
      limit: deletionLimit,
      chunkSize: deletionChunkSize,
      groupAssignmentLimit,
      groupAssignmentChunkSize,
      leaseSeconds,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Dispatcher retornou HTTP ${response.status}.`);
  console.info('[media-maintenance-worker] ciclo concluído', payload);
  return payload;
}

async function main() {
  const supabase = createSupabase();
  console.info('[media-maintenance-worker] iniciando', { workerId, runOnce, appBaseUrl });
  await heartbeat(supabase, 'starting');

  while (!stopping) {
    try {
      const payload = await tick();

      // Roda em cadencia propria (10 min por padrao), nao a cada ciclo de 5s.
      let archive = null;
      if (archiveEnabled && Date.now() - lastArchiveAt >= archiveIntervalMs) {
        lastArchiveAt = Date.now();
        archive = await archiveFinishedItems(supabase).catch((error) => {
          // Arquivamento e manutencao: falhar aqui nao pode derrubar o ciclo de
          // exclusao de midia, que e o trabalho principal deste worker.
          console.error('[media-maintenance-worker] falha no arquivamento', error);
          return null;
        });
        if (archive && archive.archived > 0) {
          console.info('[media-maintenance-worker] encerrados arquivados', archive);
        }
      }

      const deletionChunks = payload?.deletion?.chunks || 0;
      const groupAssignmentChunks = payload?.groupAssignment?.chunks || 0;
      const status = deletionChunks > 0 || groupAssignmentChunks > 0 || (archive?.archived || 0) > 0 ? 'processing' : 'idle';
      if (Date.now() - lastHeartbeatAt >= heartbeatIntervalMs) {
        await heartbeat(supabase, status, {
          deletion: payload?.deletion || null,
          groupAssignment: payload?.groupAssignment || null,
          archive,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[media-maintenance-worker] falha no ciclo', error);
      await heartbeat(supabase, 'error', {}, message).catch((heartbeatError) => {
        console.error('[media-maintenance-worker] falha ao registrar heartbeat de erro', heartbeatError);
      });
    }

    if (runOnce) break;
    await sleep(pollIntervalMs);
  }

  await heartbeat(supabase, 'stopped').catch((error) => {
    console.error('[media-maintenance-worker] falha ao registrar parada', error);
  });
  console.info('[media-maintenance-worker] finalizado', { workerId });
}

main().catch((error) => {
  console.error('[media-maintenance-worker] erro fatal', error);
  process.exitCode = 1;
});
