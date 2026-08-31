#!/usr/bin/env node

import os from 'node:os';
import fs from 'node:fs';
import process from 'node:process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import {
  dispatchPublicationQueueDirect,
  flushZernioRequestTelemetry,
  mapWithConcurrency,
  preparePublicationDispatchEnvelope,
  preparePublicationQueueDirect,
  processClaimedItem,
} from './publication-direct-dispatch.mjs';
import { PublicationDispatchSpool } from './publication-dispatch-spool.mjs';
import { createAdaptiveBulkController } from './adaptive-bulk-controller.mjs';
import {
  loadPublicationPressureSignal,
  shouldYieldToPublicationPressure as shouldStagingYieldToPressure,
  shouldForceThroughPublicationPressure as shouldForceStagingThroughCriticalDelay,
} from './publication-pressure-signal.mjs';

loadEnvFile('.env.local');
loadEnvFile('.env.worker');

const args = new Set(process.argv.slice(2));
const runOnce = args.has('--once') || process.env.PUBLICATION_WORKER_ONCE === 'true';
const workerId = process.env.PUBLICATION_WORKER_ID || `publication-${os.hostname()}-${process.pid}`;
const mode = process.env.PUBLICATION_WORKER_MODE || 'observe';
const dryRun = process.env.PUBLICATION_WORKER_DRY_RUN !== 'false';
const pollIntervalMs = integerEnv('PUBLICATION_WORKER_POLL_INTERVAL_MS', 5000, 500, 60000);
const heartbeatIntervalMs = integerEnv('PUBLICATION_WORKER_HEARTBEAT_INTERVAL_MS', 60000, 5000, 300000);
const dispatchLimit = integerEnv('PUBLICATION_WORKER_LIMIT', 5, 1, 100);
const preparationLimit = integerEnv('PUBLICATION_WORKER_PREPARATION_LIMIT', 4, 1, 500);
const preparationConcurrency = integerEnv('PUBLICATION_WORKER_PREPARATION_CONCURRENCY', 4, 1, 20);
// A preparacao roda em laco proprio desde 29/08/2026. Antes ela era executada
// DENTRO de dispatchPublicationQueueDirect, no mesmo ciclo que publica — e por
// isso o limite ficava preso em valores baixos: subir atrasava item vencido.
// Com o laco separado, o limite pode crescer sem competir com a publicacao.
// PUBLICATION_WORKER_PREPARATION_IN_DISPATCH=true volta ao comportamento antigo.
const preparationLoopEnabled = (process.env.PUBLICATION_WORKER_PREPARATION_IN_DISPATCH || 'false') !== 'true';
const preparationPollIntervalMs = integerEnv('PUBLICATION_WORKER_PREPARATION_POLL_INTERVAL_MS', 5000, 500, 60000);
// A preparação cede a vez ao despacho, mas com janela MUITO menor que a do
// staging (60 s): com ~4.000 publicações/hora sempre há algo vencendo nos
// próximos 60 s, então reusar aquele valor deixava a preparação parada.
const preparationDueGuardMs = integerEnv('PUBLICATION_WORKER_PREPARATION_DUE_GUARD_MS', 5000, 0, 60000);
// E a cessão é limitada: depois de N ciclos cedidos seguidos a preparação roda
// de qualquer forma. Fila de preparação parada é justamente o que produz item
// vencido — ceder para sempre seria trocar o problema de lugar.
const preparationMaxConsecutiveSkips = integerEnv('PUBLICATION_WORKER_PREPARATION_MAX_CONSECUTIVE_SKIPS', 3, 0, 100);
const leaseSeconds = integerEnv('PUBLICATION_WORKER_LEASE_SECONDS', 180, 30, 900);
const coordinatedRecoveryLimit = integerEnv('PUBLICATION_WORKER_COORDINATED_RECOVERY_LIMIT', 0, 0, 100);
const reconciliationOnly = process.env.PUBLICATION_WORKER_RECONCILIATION_ONLY === 'true';
const stagingEnabled = process.env.PUBLICATION_WORKER_STAGING_ENABLED === 'true';
const stagingWindowSeconds = integerEnv('PUBLICATION_WORKER_STAGING_WINDOW_SECONDS', 600, 60, 3600);
const stagingLimit = integerEnv('PUBLICATION_WORKER_STAGING_LIMIT', 100, 1, 500);
// O 4 foi escolhido quando a VPS tinha 1 nucleo. Hoje tem 2 (8 GB), e com 8 a
// medicao de 30/08/2026 deu, na espera dentro da nossa fila:
//   p90 969s -> 450s   |   mediana 33s -> 23s   |   vazao p90 111 -> 114/min
// com a maquina em 0,75 de load e 1 GB de 7 GB de memoria. O padrao muda no
// codigo, e nao so no .env da VPS, para um deploy limpo nao devolver o gargalo.
const stagingConcurrency = integerEnv('PUBLICATION_WORKER_STAGING_CONCURRENCY', 8, 1, 20);
const stagingLeaseSeconds = integerEnv('PUBLICATION_WORKER_STAGING_LEASE_SECONDS', 1200, 120, 7200);
// MEDIDO EM PRODUCAO (30/08/2026). Com 60.000 ms, "existe publicacao vencendo em
// breve" era quase sempre verdade sob carga normal, e o staging so rodava 1 ciclo
// a cada 4 (o teto de cessoes o forcava). Com 5.000 ms o mesmo heartbeat passou a
// mostrar `claimed: 25, persisted: 20, skipped: null` - trabalho de verdade, pela
// primeira vez em todas as amostras coletadas nesta investigacao.
//
// O valor de 60 s foi escolhido quando a VPS tinha 1 nucleo; hoje tem 2. E ceder
// sob pressao continua existindo pela guarda `critical_publication_delay_accepted`,
// que e a legitima e tem teto de 5 min.
const stagingDueGuardMs = integerEnv('PUBLICATION_WORKER_STAGING_DUE_GUARD_MS', 5000, 1000, 300000);
const stagedDispatchLimit = integerEnv('PUBLICATION_WORKER_STAGED_DISPATCH_LIMIT', 500, 1, 500);
const stagedDispatchConcurrency = integerEnv('PUBLICATION_WORKER_STAGED_DISPATCH_CONCURRENCY', 32, 1, 64);
const stagedDispatchLeaseSeconds = integerEnv('PUBLICATION_WORKER_STAGED_DISPATCH_LEASE_SECONDS', 900, 30, 900);
// O valor padrão (180) e o teto (antes 200) vieram do plano de estabilização de
// 27/08, quando o Supabase era Micro: era proteção do BANCO, não da Zernio.
// MEDIDO EM 29/08/2026: 2.213 publicações/hora distribuídas por 1.087 chaves
// Zernio, com pico de 4/hora por chave contra o limite de 25/hora por conta —
// 16% do teto do provedor. A Zernio não é o limitante; o teto é nosso.
// O teto de código sobe para 600 para não bloquear os degraus previstos
// (180 -> 300 -> 500 -> 600). **Subir o teto do parâmetro não muda nada
// sozinho** — o valor em uso continua vindo do .env.worker, e cada degrau só
// deve ser dado medindo memória do Supabase, taxa de 429 e itens vencidos.
const stagedMaxPerOrganizationPerMinute = integerEnv(
  'PUBLICATION_WORKER_STAGED_MAX_PER_ORGANIZATION_PER_MINUTE',
  180,
  1,
  600,
);
const spoolDirectory = process.env.PUBLICATION_WORKER_SPOOL_DIR
  || (process.platform === 'win32'
    ? path.resolve('.publication-dispatch-spool')
    : '/var/lib/athena-publication-spool');
const stagingPressureCheckIntervalMs = integerEnv('PUBLICATION_WORKER_STAGING_PRESSURE_CHECK_INTERVAL_MS', 10000, 2000, 60000);
const stagingCooperativeCancelCheckIntervalMs = integerEnv('PUBLICATION_WORKER_STAGING_CANCEL_CHECK_INTERVAL_MS', 2000, 500, 30000);

let stopping = false;
let lastHeartbeatAt = 0;
let lastCycleEventAt = 0;
let lastTelemetryFlushAt = 0;
const aggregateEventIntervalMs = 60000;
const telemetryFlushIntervalMs = 30000;
const stagedOrganizationDispatches = new Map();

// Fase 5: staging e dispatch rodam em loops independentes (ver stagingLoop/dispatchLoop
// em main()). lastStagingCycleResult é o único estado compartilhado entre os dois —
// o loop de dispatch só o lê para telemetria, nunca aguarda o loop de staging.
let lastStagingCycleResult = { claimed: 0, persisted: 0, failed: 0, skipped: null, forcedThroughCriticalDelayCount: 0 };
// Fase 6 do plano de correção do deadlock de staging: contador de quantas vezes a rede de
// segurança (shouldForceStagingThroughCriticalDelay) já precisou agir neste processo. Fica
// sempre presente em dispatch.staging/heartbeat — permanecer em 0 é o esperado; qualquer valor
// > 0 é o sinal operacional de que o próprio teto de segurança está sendo acionado (indício de
// outro problema), sem depender de um canal de alerta externo que este projeto ainda não tem.
let stagingForcedThroughCriticalDelayCount = 0;
let lastStagingPressureCheckAt = 0;
let cachedStagingPressure = {
  criticalDelay: false, overdueAccepted: null, overdueUnstarted: null, oldestDueAt: null, checkedAt: null,
};
// Marca quando a série atual de "staging cedeu ao atraso crítico" começou; null quando o
// staging não está cedendo. Alimenta shouldForceStagingThroughCriticalDelay (ver acima).
let criticalDelayYieldStreakStartedAt = null;
// MEDIDO EM PRODUCAO (30/08/2026): o heartbeat mostrava
// `dispatch.staging.skipped = 'publication_due_within_guard'` com `claimed: 0`,
// enquanto o contador do teto de pressao critica ficava em 0 - ou seja, quem
// barrava o staging era ESTE guard, que nao tinha teto nenhum.
//
// Efeito: o staging prepara envelopes com 10 min de antecedencia, mas era
// bloqueado sempre que havia algo vencendo nos proximos 60 s. Durante uma onda
// ha sempre. O pipeline serializava - prepara, publica, prepara, publica - em
// vez de preparar adiantado enquanto publica. Resultado medido: pico de 140/min
// contra mediana de 49/min, e ondas levando ~10 min para drenar quando a conta
// dizia 3 min.
//
// Mesmo remedio aplicado a preparacao: ceder e certo, ceder para sempre nao e.
// MEDIDO EM 30/08/2026: com 3, o staging cedia 3 ciclos e rodava 1 - operava a
// 25% do tempo. As ondas drenavam a 49/min de mediana enquanto o sistema ja
// demonstrara 200 publicacoes num unico minuto: a capacidade existia e nao era
// usada durante a drenagem.
//
// Com 1, ele cede uma vez e roda na seguinte. A cessao continua existindo (o
// despacho ganha a vez quando ha publicacao a menos de 5s), mas deixa de ser a
// regra. A guarda de pressao critica, ja corrigida, continua sendo a protecao
// de verdade contra staging competindo em hora ruim.
const stagingMaxConsecutiveSkips = integerEnv('PUBLICATION_WORKER_STAGING_MAX_CONSECUTIVE_SKIPS', 1, 0, 100);
// Desligado por padrao: ver o comentario extenso em runStagingCycle. O staging
// nao consome capacidade do provedor, entao ceder a pressao dele so esvazia o
// spool. Ligue de volta se aparecer contencao de banco ou de CPU.
const stagingPressureYieldEnabled = (process.env.PUBLICATION_WORKER_STAGING_PRESSURE_YIELD || 'false') === 'true';
let stagingConsecutiveSkips = 0;
const stagingCriticalDelayForceAfterMs = integerEnv(
  'PUBLICATION_WORKER_STAGING_CRITICAL_DELAY_FORCE_AFTER_MS',
  300000,
  60000,
  1800000,
);
// ACHADO POR LEITURA DE CODIGO (31/08/2026), depois de cinco experimentos em
// producao refutados. O staging ficava CRAVADO no minimo (25 itens por ciclo),
// medido: `claimed=25 persisted=25` em toda amostra, com o spool parando em ~620
// enquanto 891 itens venciam nos 12 minutos seguintes.
//
// A causa esta nos limiares PADRAO de createAdaptiveBulkController, que foram
// calibrados para fatias de BANCO DE DADOS:
//
//   fastPerItemThresholdMs = 25    -> precisa de <=25ms POR ITEM para crescer
//   maxStableDurationMs    = 3000  -> acima disso, desaba para o minimo
//   slowThresholdMs        = 750
//
// Mas o staging nao e trabalho de banco: ele monta envelopes, o que inclui
// resolver URLs de midia pela REDE (mediaProbeTimeoutMs vai a 12 SEGUNDOS por
// sonda). Nenhuma medida realista de I/O de rede fica abaixo de 25ms por item.
// Resultado: `stableThroughput` nunca era verdadeiro, o controlador nunca crescia,
// e qualquer ciclo acima de 3s o devolvia ao minimo. Travado por construcao.
//
// Os limiares abaixo sao os mesmos conceitos, na escala do trabalho real. O
// controlador compartilhado NAO muda - o worker de geracao continua com os
// padroes de banco, que para ele estao certos.
const stagingController = stagingEnabled ? createAdaptiveBulkController({
  initialStep: stagingLimit,
  minimumStep: Math.max(1, Math.min(25, Math.floor(stagingLimit / 4))),
  maximumStep: stagingLimit,
  timeoutCooldownMs: 120000,
  idleCooldownMs: 3000,
  // Escala de rede, nao de banco: resolver midia de um item custa centenas de ms.
  // 1200 vem da MEDICAO, nao de estimativa: o log do controlador mostrou o
  // staging custando 514 a 690 ms por item (resolucao de midia pela rede). Um
  // primeiro palpite de 400ms ainda ficava abaixo do custo real e mantinha o
  // controlador travado. Com 1200 (~2x o p50 observado) a operacao normal conta
  // como estavel e o passo subiu de 25 para 100; degradacao de verdade, 2x mais
  // lenta que o normal, continua barrando o crescimento.
  fastPerItemThresholdMs: integerEnv('PUBLICATION_WORKER_STAGING_FAST_PER_ITEM_MS', 1200, 25, 5000),
  maxStableDurationMs: integerEnv('PUBLICATION_WORKER_STAGING_MAX_STABLE_MS', 20000, 1000, 60000),
  slowThresholdMs: integerEnv('PUBLICATION_WORKER_STAGING_SLOW_MS', 8000, 250, 30000),
}) : null;

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
      preparationConcurrency,
      preparationLoopEnabled,
      leaseSeconds,
      reconciliationOnly,
      stagingEnabled,
      stagingWindowSeconds,
      stagingLimit,
      stagingConcurrency,
      stagingDueGuardMs,
      stagingMaxConsecutiveSkips,
      stagingConsecutiveSkips,
      stagingPressureCheckIntervalMs,
      stagingCooperativeCancelCheckIntervalMs,
      stagedDispatchLimit,
      stagedDispatchConcurrency,
      stagedMaxPerOrganizationPerMinute,
      spoolDirectory,
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

// Mesmo sinal global já consumido por zernio-sync-worker.mjs, profile-analytics-direct-worker.ts
// e publication-generation-worker.mjs: existe algum item waiting/ready com execute_at mais
// de p_critical_delay_seconds no passado, em qualquer organização. Nomes locais preservados
// (shouldStagingYieldToPressure/shouldForceStagingThroughCriticalDelay) para não quebrar quem
// já importa daqui — a implementação real é compartilhada com publication-generation-worker.mjs
// em publication-pressure-signal.mjs, para que os dois consumidores do sinal nunca caiam de
// volta no mesmo laço fechado (ver plans/plano-correcao-deadlock-staging-criticaldelay-2026-08-28.md).
export {
  shouldYieldToPublicationPressure as shouldStagingYieldToPressure,
  shouldForceThroughPublicationPressure as shouldForceStagingThroughCriticalDelay,
} from './publication-pressure-signal.mjs';

// Garante que cada loop (dispatch/staging) nunca sobreponha seu próprio ciclo, mesmo se um
// ciclo anterior ainda estiver em voo quando o polling tentar iniciar o próximo.
export function createSingleFlightGuard() {
  let busy = false;
  return {
    isBusy() {
      return busy;
    },
    async run(fn) {
      if (busy) return { skipped: true, value: undefined };
      busy = true;
      try {
        return { skipped: false, value: await fn() };
      } finally {
        busy = false;
      }
    },
  };
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
    batchRuntime: dispatch.batchRuntime && typeof dispatch.batchRuntime === 'object'
      ? {
        reconciledBatches: Number(dispatch.batchRuntime.reconciledBatches || 0),
        newlyPausedBatches: Number(dispatch.batchRuntime.newlyPausedBatches || 0),
        reconciledOutcomes: Number(dispatch.batchRuntime.reconciledOutcomes || 0),
      }
      : null,
    coordinatedRecovery: dispatch.coordinatedRecovery && typeof dispatch.coordinatedRecovery === 'object'
      ? {
        claimed: Number(dispatch.coordinatedRecovery.claimed || 0),
        finalized: Number(dispatch.coordinatedRecovery.finalized || 0),
      }
      : null,
    recyclingProcessed: Array.isArray(dispatch.recycling) ? dispatch.recycling.length : 0,
    staging: dispatch.staging && typeof dispatch.staging === 'object'
      ? {
        claimed: Number(dispatch.staging.claimed || 0),
        persisted: Number(dispatch.staging.persisted || 0),
        failed: Number(dispatch.staging.failed || 0),
        skipped: dispatch.staging.skipped ?? null,
        forcedThroughCriticalDelayCount: Number(dispatch.staging.forcedThroughCriticalDelayCount || 0),
      }
      : null,
    stagedDispatch: dispatch.stagedDispatch && typeof dispatch.stagedDispatch === 'object'
      ? {
        due: Number(dispatch.stagedDispatch.due || 0),
        selected: Number(dispatch.stagedDispatch.selected || 0),
        activated: Number(dispatch.stagedDispatch.activated || 0),
      }
      : null,
  };
}

export function fairDispatchOrder(envelopes) {
  const queues = new Map();
  for (const envelope of [...envelopes].sort((left, right) => (
    Date.parse(left.executeAt) - Date.parse(right.executeAt)
      || String(left.profileId ?? '').localeCompare(String(right.profileId ?? ''))
      || String(left.itemId).localeCompare(String(right.itemId))
  ))) {
    const key = String(envelope.organizationId ?? 'unknown');
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key).push(envelope);
  }
  const ordered = [];
  while ([...queues.values()].some((queue) => queue.length > 0)) {
    for (const key of [...queues.keys()].sort()) {
      const next = queues.get(key).shift();
      if (next) ordered.push(next);
    }
  }
  return ordered;
}

export function selectWithinOrganizationDispatchWindow(envelopes, history, now, limit, perOrganizationLimit) {
  const cutoff = now - 60_000;
  const selected = [];
  const working = new Map();
  for (const [organizationId, timestamps] of history.entries()) {
    working.set(organizationId, timestamps.filter((timestamp) => timestamp > cutoff));
  }
  // No máximo UM item por perfil e formato em cada lote. Sem isso, itens irmãos
  // do mesmo perfil saem juntos, com concorrência 32, e chegam à reserva de
  // capacidade no mesmo instante — foi o que produziu intervalos de 0 min entre
  // reels do mesmo perfil. O segundo item não se perde: volta no ciclo seguinte,
  // poucos segundos depois, e aí a guarda de espaçamento decide com o estado já
  // atualizado. Envelope antigo no spool não traz `format`; cai em 'unknown',
  // que é o comportamento mais conservador (1 por perfil).
  const perProfileFormat = new Set();
  for (const envelope of fairDispatchOrder(envelopes)) {
    if (selected.length >= limit) break;
    const organizationId = String(envelope.organizationId ?? 'unknown');
    const profileFormatKey = `${envelope.profileId ?? 'unknown'}:${envelope.format ?? 'unknown'}`;
    if (perProfileFormat.has(profileFormatKey)) continue;
    const timestamps = working.get(organizationId) ?? [];
    if (timestamps.length >= perOrganizationLimit) continue;
    perProfileFormat.add(profileFormatKey);
    timestamps.push(now);
    working.set(organizationId, timestamps);
    selected.push(envelope);
  }
  return { selected, nextHistory: working };
}

async function stageUpcomingPublications(supabase, spool, correlationId, options = {}) {
  const limit = Number.isInteger(options.limit) ? Math.min(Math.max(options.limit, 1), stagingLimit) : stagingLimit;
  const shouldStop = options.shouldStop ?? (() => false);
  const stageWorkerId = workerId;
  const { data, error } = await supabase.rpc('claim_publication_dispatch_staging_items', {
    p_worker_id: stageWorkerId,
    p_limit: limit,
    p_stage_lease_seconds: stagingLeaseSeconds,
    p_window_seconds: stagingWindowSeconds,
  });
  if (error) throw error;
  const claimed = data ?? [];
  const settled = await mapWithConcurrency(claimed, stagingConcurrency, async (item) => {
    const envelope = await preparePublicationDispatchEnvelope({ ...item, correlation_id: correlationId });
    await spool.put(envelope);
    return envelope.itemId;
  }, shouldStop);
  // Entradas nunca tentadas (cancelamento cooperativo interrompeu o lote antes de chegar
  // nelas) ficam undefined em settled — precisam ser liberadas junto das rejeitadas, senão
  // ficam presas sob o lease deste worker até expirar.
  const releaseIds = settled.flatMap((entry, index) => (!entry || entry.status === 'rejected') ? [claimed[index].id] : []);
  const cancelledCount = settled.filter((entry) => !entry).length;
  if (releaseIds.length > 0) {
    const { error: releaseError } = await supabase.rpc('release_publication_dispatch_staging', {
      p_worker_id: stageWorkerId,
      p_item_ids: releaseIds,
    });
    if (releaseError) console.error('[publication-worker] falha ao liberar staging incompleto', errorMessage(releaseError));
  }
  return {
    claimed: claimed.length,
    persisted: settled.filter((entry) => entry && entry.status === 'fulfilled').length,
    failed: releaseIds.length - cancelledCount,
    cancelled: cancelledCount,
  };
}

// A preparação cede a vez ao despacho, mas a cessão é LIMITADA. Sem o teto, com
// ~4.000 publicações/hora sempre existe algo vencendo dentro da janela e a
// preparação ficaria com `claimed: 0` em todos os ciclos — pior do que antes de
// separar os laços, já que antes ela ao menos rodava junto com o despacho.
export function shouldYieldToDueWindow(
  publicationDueWithinGuard,
  consecutiveSkips,
  maxConsecutiveSkips,
) {
  if (!publicationDueWithinGuard) return false;
  return consecutiveSkips < maxConsecutiveSkips;
}

export function shouldPreparationYieldToDispatch(
  publicationDueWithinGuard,
  consecutiveSkips,
  maxConsecutiveSkips = preparationMaxConsecutiveSkips,
) {
  return shouldYieldToDueWindow(publicationDueWithinGuard, consecutiveSkips, maxConsecutiveSkips);
}

export async function stagingHasSafeWindow(spool, now = Date.now(), dueGuardMs = stagingDueGuardMs) {
  const nearDue = await spool.listDue(now + dueGuardMs, 1);
  return nearDue.length === 0;
}

// Entrada de spool so vale enquanto o lease de staging dela vale. Sem isto, um
// item cujo lease expirou fica no spool PARA SEMPRE: e escolhido a cada ciclo,
// a ativacao o recusa, e nada nunca o remove.
//
// MEDIDO EM PRODUCAO (30/08/2026): o log repetia
//   due: 43, selected: 5, activated: 0
// dezenas de vezes seguidas. Os 43 tinham 100% dos leases de staging expirados,
// um deles com execute_at de 29 HORAS antes e status ja `ignored` no banco. Eram
// zumbis girando em falso desde o dia anterior.
//
// O banco e a fonte da verdade: se o item ainda precisa sair, o staging o
// reivindica de novo (o lease expirado o torna reclamavel). Remover a entrada
// morta nao perde publicacao nenhuma.
async function discardUnactivatableSpoolEntries(supabase, spool, itemIds) {
  if (!itemIds.length) return 0;
  // Em blocos, e nao num `.in()` unico: o lote de despacho vai ate
  // PUBLICATION_WORKER_STAGED_DISPATCH_LIMIT (500), e 500 UUIDs viram uma URL de
  // GET com ~18 KB. O CLAUDE.md alerta para isso a partir de 1.000 (~37 KB); 500
  // esta abaixo do alerta mas ainda e grande o bastante para depender de limite
  // de header do gateway. Em blocos de 200 (~7,4 KB) nao depende.
  //
  // O 200 e o mesmo DEFAULT_ID_CHUNK_SIZE de lib/supabase/chunk.ts. A duplicacao
  // e DELIBERADA, e o motivo nao e "porque e .mjs" - a VPS roda Node v22.23.2 e o
  // type stripping nativo importaria o .ts sem problema hoje.
  //
  // O motivo e o contrato: este worker nao tem HOJE nenhuma dependencia de
  // TypeScript (so builtins do Node, @supabase/supabase-js e .mjs locais), e o
  // package.json declara `engines: node >=18.0.0`. Importar o helper criaria um
  // requisito novo de Node >= 22.6 para o publicador rodar, e o modo de falha e
  // o pior possivel: o worker nao sobe, e publicacao para. Trocar isso por
  // apagar uma constante e mau negocio.
  //
  // Se um dia o engines subir para >= 22.6, ou se este worker passar a rodar sob
  // tsx, a duplicacao deixa de ter razao de ser: importe o helper e apague o
  // numero. Ate la, se DEFAULT_ID_CHUNK_SIZE mudar la, mude aqui junto (existe
  // nota reciproca no chunk.ts apontando para ca).
  const byId = new Map();
  for (let from = 0; from < itemIds.length; from += 200) {
    const bloco = itemIds.slice(from, from + 200);
    const { data, error } = await supabase
      .from('publication_items')
      .select('id, status, archived_at, dispatch_staged_until')
      .in('id', bloco);
    if (error) {
      console.error('[publication-worker] não foi possível verificar entradas de spool não ativadas', {
        workerId,
        message: errorMessage(error),
        bloco: bloco.length,
      });
      return 0;
    }
    for (const row of data ?? []) byId.set(row.id, row);
  }
  const now = Date.now();
  let discarded = 0;
  for (const itemId of itemIds) {
    const row = byId.get(itemId);
    // Linha sumiu do banco, ja foi arquivada, chegou a estado terminal, ou o
    // lease de staging expirou — nos quatro casos a entrada nao serve mais.
    const morta = !row
      || row.archived_at != null
      || ['published', 'cancelled', 'ignored', 'removed'].includes(row.status)
      || !row.dispatch_staged_until
      || Date.parse(row.dispatch_staged_until) <= now;
    if (!morta) continue;
    await spool.remove(itemId);
    discarded += 1;
  }
  if (discarded > 0) {
    console.info('[publication-worker] entradas de spool descartadas', { workerId, discarded });
  }
  return discarded;
}

// INSTRUMENTACAO DO LACO DE DESPACHO (30/08/2026).
//
// Por que existe: as ondas GRANDES criam a ~75 posts/min enquanto as PEQUENAS
// criam a ~800/min, na mesma maquina, no mesmo minuto, contra a mesma Zernio.
// Cada criacao custa 6,5s medidos, e com concorrencia 49 isso deveria dar
// ~450/min. Existe um fator de ~6 escondido no laco que quatro experimentos de
// tentativa-e-erro nao acharam (staging, concorrencia do staged dispatch, teto
// por organizacao e cessao do guard foram todos refutados por medicao).
//
// Medir pelo RESULTADO nao funciona aqui: o sistema recebe atividade humana
// concorrente (agendamento em massa, cancelamento, sincronizacao de perfis) que
// muda os tempos e some com a atribuicao de causa. Medindo POR DENTRO, cada
// ciclo diz onde o proprio tempo foi, sem depender do que mais acontecia.
//
// Custo: um Date.now() por fase e uma ordenacao de array por ciclo. Desprezivel
// perto dos 6,5s de uma unica chamada ao provedor.
function resumoDeTempos(amostras) {
  if (!amostras.length) return null;
  const ordenado = [...amostras].sort((a, b) => a - b);
  const emP = (p) => ordenado[Math.min(ordenado.length - 1, Math.floor(ordenado.length * p))];
  return {
    n: ordenado.length,
    p50: Math.round(emP(0.5)),
    p90: Math.round(emP(0.9)),
    max: Math.round(ordenado[ordenado.length - 1]),
    somaMs: Math.round(ordenado.reduce((a, b) => a + b, 0)),
  };
}

async function dispatchDueStagedPublications(supabase, spool, correlationId) {
  const cicloIniciadoEm = Date.now();
  const fases = {};
  const marcar = (nome, desde) => { fases[nome] = Date.now() - desde; };

  const now = Date.now();
  const allDue = await spool.listDue(now, 5000);
  marcar('lerSpool', now);
  const selecaoIniciadaEm = Date.now();
  const windowed = selectWithinOrganizationDispatchWindow(
    allDue,
    stagedOrganizationDispatches,
    now,
    stagedDispatchLimit,
    stagedMaxPerOrganizationPerMinute,
  );
  const due = windowed.selected;
  marcar('selecionar', selecaoIniciadaEm);
  stagedOrganizationDispatches.clear();
  for (const [organizationId, timestamps] of windowed.nextHistory.entries()) {
    stagedOrganizationDispatches.set(organizationId, timestamps);
  }
  if (due.length === 0) return { due: allDue.length, selected: 0, activated: 0, processed: [] };
  const ativacaoIniciadaEm = Date.now();
  const { data, error } = await supabase.rpc('activate_staged_publication_items', {
    p_worker_id: workerId,
    p_item_ids: due.map((entry) => entry.itemId),
    p_lease_seconds: stagedDispatchLeaseSeconds,
  });
  if (error) throw error;
  marcar('ativarNoBanco', ativacaoIniciadaEm);
  const claimedById = new Map((data ?? []).map((item) => [item.id, item]));
  const activated = due.filter((entry) => claimedById.has(entry.itemId));
  const descarteIniciadoEm = Date.now();
  await discardUnactivatableSpoolEntries(
    supabase,
    spool,
    due.filter((entry) => !claimedById.has(entry.itemId)).map((entry) => entry.itemId),
  );
  marcar('descartarMortos', descarteIniciadoEm);

  // Por item: quanto tempo cada um passou DENTRO de processClaimedItem (que
  // inclui reserva de capacidade, chamada ao provedor e escrita de volta), e
  // quanto ficou esperando slot de concorrencia antes de comecar.
  const processamentoIniciadoEm = Date.now();
  const duracaoPorItem = [];
  const esperaPorSlot = [];
  const settled = await mapWithConcurrency(activated, stagedDispatchConcurrency, async (envelope) => {
    const comecouEm = Date.now();
    esperaPorSlot.push(comecouEm - processamentoIniciadoEm);
    const item = { ...claimedById.get(envelope.itemId), correlation_id: correlationId };
    try {
      const result = await processClaimedItem(item, workerId, envelope);
      await spool.remove(envelope.itemId);
      return result;
    } finally {
      duracaoPorItem.push(Date.now() - comecouEm);
    }
  });
  marcar('processarItens', processamentoIniciadoEm);
  const processed = settled.map((entry, index) => entry.status === 'fulfilled'
    ? entry.value
    : { itemId: activated[index].itemId, state: 'error', error: errorMessage(entry.reason) });
  // So loga quando houve trabalho de verdade: em vale de agendamento isso rodaria
  // a cada 5s sem dizer nada.
  if (activated.length > 0) {
    console.info('[publication-worker] tempos do ciclo de despacho', {
      workerId,
      itens: activated.length,
      concorrencia: stagedDispatchConcurrency,
      cicloMs: Date.now() - cicloIniciadoEm,
      fasesMs: fases,
      porItemMs: resumoDeTempos(duracaoPorItem),
      esperaPorSlotMs: resumoDeTempos(esperaPorSlot),
    });
  }

  return { due: allDue.length, selected: due.length, activated: activated.length, processed };
}

export function dispatchHasOperationalActivity(dispatch) {
  const summary = summarizeDispatch(dispatch);
  if (!summary) return false;
  return summary.claimed > 0
    || Object.values(summary.outcomes).some((count) => count > 0)
    || Number(summary.preparation?.claimed || 0) > 0
    || Number(summary.recovery?.rescheduled || 0) > 0
    || Number(summary.coordinatedRecovery?.claimed || 0) > 0
    || summary.recyclingProcessed > 0;
}

// Ciclo de despacho: prioridade alta, roda no próprio loop e nunca aguarda staging.
// dispatch.staging carrega o último resultado conhecido do loop de staging (produtor
// independente) só para telemetria — o despacho não bloqueia nem depende dele.
async function runDispatchCycle(supabase, correlationId, spool = null) {
  if (mode === 'observe' || dryRun) {
    const rows = await loadSummary(supabase);
    const totals = queueTotals(rows);
    console.info('[publication-worker] observação', { workerId, dryRun, totals });
    return { status: 'observing', totals, dispatch: null };
  }

  if (mode === 'dispatch-endpoint') {
    const dispatch = await dispatchThroughEndpoint();
    console.info('[publication-worker] dispatch remoto concluído', { workerId, dispatch });
    return { status: 'dispatching', totals: null, dispatch };
  }

  if (mode === 'direct' || mode === 'direct-dispatch') {
    const stagedDispatch = stagingEnabled && spool
      ? await dispatchDueStagedPublications(supabase, spool, correlationId)
      : { due: 0, selected: 0, activated: 0, processed: [] };
    const dispatch = await dispatchPublicationQueueDirect({
      workerId,
      limit: dispatchLimit,
      leaseSeconds,
      skipPreparation: preparationLoopEnabled,
      preparationLimit,
      preparationConcurrency,
      correlationId,
      recoveryLimit: coordinatedRecoveryLimit,
      reconciliationOnly,
    });
    dispatch.stagedDispatch = stagedDispatch;
    dispatch.staging = lastStagingCycleResult;
    dispatch.claimed += stagedDispatch.activated;
    dispatch.processed = [...stagedDispatch.processed, ...dispatch.processed];
    console.info('[publication-worker] dispatch direto concluído', { workerId, dispatch: summarizeDispatch(dispatch) });
    return { status: 'dispatching', totals: null, dispatch };
  }

  throw new Error(`Modo de worker não suportado nesta etapa: ${mode}`);
}

// Ciclo de staging: segundo plano, independente do dispatch. Cede (guarda local +
// controlador adaptativo + pressão crítica global) antes de reivindicar qualquer item, e
// cancela cooperativamente um lote em andamento assim que algo entra na janela de guarda.
async function runStagingCycle(supabase, spool) {
  const now = Date.now();

  const publicationDueWithinGuard = !(await stagingHasSafeWindow(spool, now));
  if (shouldYieldToDueWindow(publicationDueWithinGuard, stagingConsecutiveSkips, stagingMaxConsecutiveSkips)) {
    stagingConsecutiveSkips += 1;
    return {
      claimed: 0,
      persisted: 0,
      failed: 0,
      skipped: 'publication_due_within_guard',
      consecutiveSkips: stagingConsecutiveSkips,
    };
  }
  stagingConsecutiveSkips = 0;
  if (!stagingController.canRun(now)) {
    return { claimed: 0, persisted: 0, failed: 0, skipped: 'adaptive_cooldown' };
  }

  if (now - lastStagingPressureCheckAt >= stagingPressureCheckIntervalMs) {
    lastStagingPressureCheckAt = now;
    try {
      cachedStagingPressure = await loadPublicationPressureSignal(supabase, 60);
    } catch (pressureError) {
      console.error('[publication-worker] falha ao consultar pressão crítica de publicação', errorMessage(pressureError));
    }
  }
  // MEDIDO EM PRODUCAO (30/08/2026, 19h48): amostrando o heartbeat a cada 12s, o
  // staging aparecia com `claimed: 0` em TODAS as amostras, alternando entre tres
  // motivos - adaptive_cooldown, critical_publication_delay_accepted e
  // publication_due_within_guard. Consequencia: o spool nunca enche, e o laco de
  // despacho pega no maximo 34 itens numa onda de 450, com 64 vagas de
  // concorrencia OCIOSAS (espera por slot medida: 3ms).
  //
  // A guarda que mais bloqueia e a de pressao - e a regra que eu mesmo escrevi
  // hoje de manha. Ela manda ceder quando o atraso e puramente de itens JA
  // ACEITOS pelo provedor. Durante uma onda isso e SEMPRE verdade: os itens sao
  // criados e esperam ~75s pela confirmacao. Entao o staging para durante a onda
  // inteira, que e exatamente quando ele precisa encher o spool para a proxima.
  //
  // O raciocinio estava errado para ESTE consumidor. O staging NAO chama a API de
  // publicacao da Zernio - ele le o banco e resolve URLs de midia. Ceder
  // capacidade de provedor que ele nao consome nao protege ninguem; so garante
  // que a proxima onda comece com o spool vazio.
  //
  // `stagingPressureYieldEnabled` deixa isso reversivel sem deploy: se a medicao
  // mostrar contencao de banco ou de CPU com o staging solto, basta ligar.
  if (stagingPressureYieldEnabled
    && cachedStagingPressure.criticalDelay
    && shouldStagingYieldToPressure(cachedStagingPressure, { resolvesUnstarted: true })) {
    const forceThrough = shouldForceStagingThroughCriticalDelay(
      criticalDelayYieldStreakStartedAt, now, stagingCriticalDelayForceAfterMs,
    );
    if (!forceThrough) {
      if (criticalDelayYieldStreakStartedAt == null) criticalDelayYieldStreakStartedAt = now;
      stagingController.markCriticalDelay(now);
      return {
        claimed: 0,
        persisted: 0,
        failed: 0,
        skipped: cachedStagingPressure.overdueAccepted === true
          ? 'critical_publication_delay_accepted'
          : 'critical_publication_delay',
      };
    }
    stagingForcedThroughCriticalDelayCount += 1;
    console.warn('[publication-worker] staging forçado apesar de atraso crítico: teto de segurança atingido', {
      streakMs: now - criticalDelayYieldStreakStartedAt,
      thresholdMs: stagingCriticalDelayForceAfterMs,
      pressure: cachedStagingPressure,
      forcedThroughCriticalDelayCount: stagingForcedThroughCriticalDelayCount,
    });
  }
  criticalDelayYieldStreakStartedAt = null;

  const limit = stagingController.snapshot(now).currentStep;
  const correlationId = randomUUID();

  let cancelled = false;
  let checkingCancel = false;
  const cancelWatcher = setInterval(() => {
    if (checkingCancel) return;
    checkingCancel = true;
    stagingHasSafeWindow(spool, Date.now())
      .then((safe) => {
        if (!safe) cancelled = true;
      })
      .catch(() => {})
      .finally(() => {
        checkingCancel = false;
      });
  }, stagingCooperativeCancelCheckIntervalMs);

  const startedAt = Date.now();
  let result;
  let cycleError = null;
  try {
    result = await stageUpcomingPublications(supabase, spool, correlationId, { limit, shouldStop: () => cancelled });
  } catch (error) {
    cycleError = error;
    result = { claimed: 0, persisted: 0, failed: 0, cancelled: 0 };
  } finally {
    clearInterval(cancelWatcher);
  }
  const durationMs = Date.now() - startedAt;

  const estadoDoControlador = stagingController.observe({
    durationMs,
    ok: !cycleError,
    message: cycleError ? errorMessage(cycleError) : '',
    processedItems: result.persisted,
    now: Date.now(),
  });
  // O estado do controlador era invisivel de fora, e foi por isso que demorei
  // cinco experimentos para achar que ele estava travado no minimo. Fica no log
  // sempre que houver trabalho, com o motivo da ultima decisao.
  if (result.persisted > 0) {
    console.info('[publication-worker] controlador do staging', {
      workerId,
      passoAtual: estadoDoControlador.currentStep,
      minimo: estadoDoControlador.minimumStep,
      maximo: estadoDoControlador.maximumStep,
      motivo: estadoDoControlador.lastReason,
      duracaoMs: estadoDoControlador.lastDurationMs,
      msPorItem: estadoDoControlador.lastDurationPerItemMs,
      itens: result.persisted,
    });
  }

  if (cycleError) throw cycleError;

  return {
    claimed: result.claimed,
    persisted: result.persisted,
    failed: result.failed,
    skipped: cancelled && result.cancelled > 0 ? 'publication_due_within_guard' : null,
  };
}

async function reportCycle(supabase, correlationId, startedAt, result) {
  // Telemetria é auxiliar: não aguardamos e nunca deixamos falha dela interromper a fila.
  if (Date.now() - lastTelemetryFlushAt >= telemetryFlushIntervalMs) {
    lastTelemetryFlushAt = Date.now();
    void flushZernioRequestTelemetry().catch((telemetryError) => {
      console.error('[publication-worker] falha não bloqueante na telemetria Zernio', telemetryError);
    });
  }
  if (dispatchHasOperationalActivity(result.dispatch) || Date.now() - lastCycleEventAt >= aggregateEventIntervalMs) {
    await recordCycleEvent(supabase, {
      correlationId,
      phase: 'completed',
      startedAt,
      completedAt: new Date().toISOString(),
      metadata: { totals: result.totals, dispatch: summarizeDispatch(result.dispatch) },
    });
    lastCycleEventAt = Date.now();
  }
  if (Date.now() - lastHeartbeatAt >= heartbeatIntervalMs) {
    await heartbeat(supabase, result.status, {
      totals: result.totals,
      dispatch: summarizeDispatch(result.dispatch),
    });
  }
}

async function reportCycleFailure(supabase, correlationId, startedAt, error) {
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

const dispatchGuard = createSingleFlightGuard();
const stagingGuard = createSingleFlightGuard();
const preparationGuard = createSingleFlightGuard();
let lastPreparationCycleResult = null;
let preparationConsecutiveSkips = 0;

async function dispatchLoop(supabase, spool) {
  while (!stopping) {
    const correlationId = randomUUID();
    const startedAt = new Date().toISOString();
    await dispatchGuard.run(async () => {
      try {
        const result = await runDispatchCycle(supabase, correlationId, spool);
        await reportCycle(supabase, correlationId, startedAt, result);
      } catch (error) {
        await reportCycleFailure(supabase, correlationId, startedAt, error);
      }
    });

    if (runOnce) break;
    await sleep(pollIntervalMs);
  }
}

async function stagingLoop(supabase, spool) {
  // Mesma condição que hoje decide se o worker sequer tenta staging: modo direto, staging
  // ligado, fora de reconciliação e fora de dry-run/observe.
  if (!stagingEnabled || !spool || dryRun || reconciliationOnly || (mode !== 'direct' && mode !== 'direct-dispatch')) {
    return;
  }

  while (!stopping) {
    await stagingGuard.run(async () => {
      try {
        lastStagingCycleResult = {
          ...(await runStagingCycle(supabase, spool)),
          forcedThroughCriticalDelayCount: stagingForcedThroughCriticalDelayCount,
        };
      } catch (error) {
        console.error('[publication-worker] falha no ciclo de staging', { workerId, message: errorMessage(error) });
      }
    });

    if (runOnce) break;
    await sleep(pollIntervalMs);
  }
}

// Laco proprio da preparacao de midia. Espelha stagingLoop: polling proprio,
// mutex contra sobreposicao e a mesma flag `stopping` em SIGTERM.
//
// A contrapressao importa tanto quanto a separacao: se houver item vencendo
// agora, a preparacao cede a vez, porque publicar no horario vale mais do que
// adiantar midia de item futuro. E a mesma guarda que o staging ja usa.
async function preparationLoop(supabase, spool) {
  if (!preparationLoopEnabled || dryRun || reconciliationOnly || (mode !== 'direct' && mode !== 'direct-dispatch')) {
    return;
  }

  while (!stopping) {
    await preparationGuard.run(async () => {
      try {
        const publicationDueWithinGuard = spool
          ? !(await stagingHasSafeWindow(spool, Date.now(), preparationDueGuardMs))
          : false;
        if (shouldPreparationYieldToDispatch(publicationDueWithinGuard, preparationConsecutiveSkips)) {
          preparationConsecutiveSkips += 1;
          lastPreparationCycleResult = {
            skipped: 'publication_due_within_guard',
            consecutive: preparationConsecutiveSkips,
          };
          return;
        }
        preparationConsecutiveSkips = 0;
        const result = await preparePublicationQueueDirect({
          workerId: `${workerId}:prepare`.slice(0, 120),
          limit: preparationLimit,
          concurrency: preparationConcurrency,
          leaseSeconds: Math.max(300, leaseSeconds),
          windowHours: 24,
          correlationId: randomUUID(),
        });
        lastPreparationCycleResult = {
          claimed: result.claimed,
          ready: result.ready,
          blocked: result.blocked,
          errors: result.errors,
        };
        if (result.claimed > 0) {
          console.info('[publication-worker] ciclo de preparação', { workerId, ...lastPreparationCycleResult });
        }
      } catch (error) {
        lastPreparationCycleResult = { error: errorMessage(error) };
        console.error('[publication-worker] falha no ciclo de preparação', { workerId, message: errorMessage(error) });
      }
    });

    if (runOnce) break;
    await sleep(preparationPollIntervalMs);
  }
}

async function main() {
  const supabase = createSupabase();
  const spool = stagingEnabled ? await new PublicationDispatchSpool(spoolDirectory).initialize() : null;
  console.info('[publication-worker] iniciando', { workerId, mode, dryRun, runOnce, reconciliationOnly });
  await heartbeat(supabase, 'starting');

  // Os dois loops compartilham a mesma flag `stopping`: em SIGTERM/SIGINT, cada um termina
  // seu ciclo em voo (chamadas já aceitas ao provedor) e não inicia um novo.
  await Promise.all([
    dispatchLoop(supabase, spool),
    stagingLoop(supabase, spool),
    preparationLoop(supabase, spool),
  ]);

  await heartbeat(supabase, 'stopped').catch((error) => {
    console.error('[publication-worker] falha ao registrar parada', error);
  });
  console.info('[publication-worker] finalizado', { workerId });
}

const executedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (executedDirectly) {
  main().catch((error) => {
    console.error('[publication-worker] erro fatal', error);
    process.exitCode = 1;
  });
}
