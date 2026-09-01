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

// B4 (arquivo frio). DESLIGADO POR PADRAO, de proposito: a capacidade fica
// pronta, mas so entra em acao quando o gatilho documentado disparar - memoria
// do Supabase acima de 85%, disco acima de 80%, ou publication_items passando
// de 1 milhao de linhas. Ligar antes disso gasta I/O sem necessidade.
const coldStorageEnabled = (process.env.MEDIA_MAINTENANCE_COLD_STORAGE_ENABLED || 'false') === 'true';
const coldStorageIntervalMs = integerEnv('MEDIA_MAINTENANCE_COLD_STORAGE_INTERVAL_MS', 3600000, 300000, 21600000);
// O orcamento e o ciclo de trabalho do dreno: ele trabalha `budget` a cada
// `interval`. Com 30s a cada 300s eram 10% do tempo, e o dreno movia 50/min
// contra ~38/min de entrada — 30% de folga, que os +600 perfis planejados para
// 01/09 fechariam quase por completo. Com 90s a cada 300s (30%) medi 149/min,
// tres vezes mais, e o backlog de 80 mil elegiveis caiu de 27h para 8,9h.
const coldStorageBudgetMs = integerEnv('MEDIA_MAINTENANCE_COLD_STORAGE_BUDGET_MS', 90000, 1000, 120000);
const coldStorageRetentionDays = integerEnv('MEDIA_MAINTENANCE_COLD_STORAGE_RETENTION_DAYS', 7, 7, 90);
// MEDIDO EM 30/08/2026, logo depois dos indices da migration 334:
//   1 item .... 960ms   |  50 itens .. 4.019ms
//  10 itens .. 1.699ms  | 100 itens .. 7.973ms  (na beira do timeout de 8s)
//
// REMEDIDO EM 01/09/2026: o mesmo lote de 50 passou a levar ~10s, e comecou a
// bater no statement timeout de verdade (69 falhas). O custo por item dobrou em
// dois dias porque cada delete resolve 14 chaves estrangeiras sobre tabelas que
// nao pararam de crescer. Lote de 25 volta para ~5s, com folga.
//
// A LICAO: este numero nao e constante, ele degrada junto com o tamanho das
// tabelas referenciadoras. Se voltarem timeouts, o remedio e baixar o LOTE, nao
// aumentar o orcamento — lote grande que estoura nao move item nenhum.
const coldStorageBatch = integerEnv('MEDIA_MAINTENANCE_COLD_STORAGE_BATCH', 25, 1, 100);

let lastArchiveAt = 0;
let lastColdStorageAt = 0;

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
//
// Desde a migration 335 a RPC so arquiva falha TERMINAL (next_attempt_at nulo
// ou attempt_count >= 5, mais janela de acomodacao de 15 min). Antes dela este
// laco arquivava qualquer item em 'failed' a cada 10 minutos, inclusive os que
// tinham retry marcado: com archived_at preenchido, claim_publication_items
// nunca mais reivindicava o item e a publicacao sumia em silencio — a mesma
// rotina ainda gravava o acknowledgement, entao nem no KPI de erros aparecia.
// Nao volte a passar um predicado mais largo daqui.
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

// Move para o arquivo frio o que ja passou da retencao. A funcao no banco tem
// piso de 7 dias e copia publication_item_media ANTES do delete, porque a FK
// original e `on delete cascade` e o delete apagaria o registro de qual midia
// foi publicada.
async function moveArchivedItemsToColdStorage(supabase) {
  const startedAt = Date.now();
  const { data: organizations, error } = await supabase.from('organizations').select('id, name');
  if (error) throw error;

  let movedItems = 0;
  let movedMedia = 0;
  let exhaustedBudget = false;

  for (const organization of organizations || []) {
    while (Date.now() - startedAt < coldStorageBudgetMs) {
      const { data, error: moveError } = await supabase.rpc('move_archived_publication_items_to_cold_storage', {
        p_organization_id: organization.id,
        p_retention_days: coldStorageRetentionDays,
        p_limit: coldStorageBatch,
      });
      if (moveError) {
        // A divergencia de colunas entre a tabela quente e a fria chega aqui.
        // E erro de manutencao, nao de dado: precisa aparecer inteiro no log.
        console.error('[media-maintenance-worker] falha ao mover para o arquivo frio', {
          organization: organization.name,
          message: moveError.message,
        });
        break;
      }
      movedItems += data?.movedItems || 0;
      movedMedia += data?.movedMedia || 0;
      if (!data?.hasMore) break;
    }
    if (Date.now() - startedAt >= coldStorageBudgetMs) {
      exhaustedBudget = true;
      break;
    }
  }

  return { movedItems, movedMedia, exhaustedBudget, durationMs: Date.now() - startedAt };
}

// Limpeza das reservas de despacho vencidas. Saiu do caminho critico na migration
// 341: antes, `reserve_publication_dispatch_capacity` fazia um delete da tabela
// inteira DENTRO do advisory lock por organizacao, em toda publicacao - trabalho
// O(tabela) num lock que ja e o teto de vazao da fila.
//
// Aqui o atraso e inofensivo: as leituras da funcao passaram a exigir
// `expires_at > now`, entao linha vencida ja nao conta para nada. O unico custo
// de nao limpar e tabela maior que o necessario.
async function limparReservasVencidas(supabase) {
  let removidas = 0;
  for (let volta = 0; volta < 20; volta += 1) {
    const { data, error } = await supabase.rpc('purge_expired_publication_dispatch_reservations', {
      p_limit: 5000,
    });
    if (error) {
      console.error('[media-maintenance-worker] falha ao limpar reservas vencidas', {
        message: error.message,
      });
      break;
    }
    const nesta = Number(data) || 0;
    removidas += nesta;
    if (nesta < 5000) break;
  }
  return removidas;
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

      let coldStorage = null;
      if (coldStorageEnabled && Date.now() - lastColdStorageAt >= coldStorageIntervalMs) {
        lastColdStorageAt = Date.now();
        coldStorage = await moveArchivedItemsToColdStorage(supabase).catch((error) => {
          console.error('[media-maintenance-worker] falha no arquivo frio', error);
          return null;
        });
        if (coldStorage && coldStorage.movedItems > 0) {
          console.info('[media-maintenance-worker] itens movidos para o arquivo frio', coldStorage);
        }
      }

      // Mesma cadencia do arquivamento: e manutencao, nao caminho critico.
      if (archiveEnabled && archive !== null) {
        const reservasRemovidas = await limparReservasVencidas(supabase).catch((error) => {
          console.error('[media-maintenance-worker] limpeza de reservas falhou', error);
          return 0;
        });
        if (reservasRemovidas > 0) {
          console.info('[media-maintenance-worker] reservas de despacho vencidas removidas', {
            itens: reservasRemovidas,
          });
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
