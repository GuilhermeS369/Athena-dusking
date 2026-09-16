import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createClient } from '@supabase/supabase-js';
// A decisao sobre o status do conteiner vive em lib/integrations/meta-graph-errors.ts,
// a MESMA que o publisher do painel usa. Este arquivo ja teve copia propria dela, e
// foi assim que a correcao de 04/09 nasceu valendo so metade: o painel adiava o
// ERROR e este worker -- que e quem realmente publica -- continuava encerrando.
// Import relativo com extensao porque a VPS roda com `node` puro, sem tsx.
import { metaContainerVerdict, isMetaAppApiBlocked, META_MEDIA_FETCH_ERROR_CODE, META_MEDIA_NOT_AVAILABLE_ERROR_CODE } from '../../lib/integrations/meta-graph-errors.ts';

export const PUBLICATION_MAX_ATTEMPTS = 5;

// 'supabase' (padrão) usa o Storage do Supabase, que cobra egress por byte
// transferido. 'r2' usa Cloudflare R2 (egress $0), mantendo o mesmo
// comportamento de gerar uma signed URL nova por despacho — necessário porque
// a Zernio rejeita como "duplicate content" quando a mesma URL física é
// reenviada para a mesma conta em menos de 24h (ver
// docs/athena-publication-pipeline-v2-2026-08-24.md).
//
// Import dinâmico e só dentro do ramo 'r2': um import estático de
// '@aws-sdk/client-s3' no topo do módulo seria içado e avaliado no load do
// worker, quebrando o processo inteiro se o pacote não estiver instalado —
// mesmo com a flag desligada. Isso já causou um crash-loop em produção
// (28/08/2026) quando o arquivo foi implantado antes do `npm install`.
// Função, não constante: este módulo é importado por publication-worker.mjs
// ANTES de rodar loadEnvFile('.env.worker') (import estático roda primeiro que
// qualquer statement do módulo que importa). Uma const calculada aqui no topo
// travaria para sempre em 'supabase', porque process.env.MEDIA_STORAGE_BACKEND
// ainda não existiria no momento em que o import é avaliado. Isso já causou a
// flag nunca surtir efeito em produção mesmo com o .env.worker correto.
function mediaStorageBackend() {
  return (process.env.MEDIA_STORAGE_BACKEND || 'supabase').toLowerCase();
}
let r2ClientPromise = null;
async function getR2Client() {
  if (!r2ClientPromise) {
    r2ClientPromise = import('@aws-sdk/client-s3').then(({ S3Client }) => new S3Client({
      region: 'auto',
      endpoint: requiredEnv('R2_ENDPOINT'),
      credentials: {
        accessKeyId: requiredEnv('R2_ACCESS_KEY_ID'),
        secretAccessKey: requiredEnv('R2_SECRET_ACCESS_KEY'),
      },
    }));
  }
  return r2ClientPromise;
}

const graphVersion = process.env.META_GRAPH_API_VERSION ?? 'v26.0';
const metaRequestTimeoutMs = 25_000;
// `media_publish` ganha limite proprio, e maior. Diagnosticado em 05/09/2026
// depois que os timeouts passaram a ser rotulados: TODOS estouravam em
// `meta_timeout_publicar` -- nenhum ao criar conteiner, nenhum ao consultar
// status. Os outros dois FICAM em 25 s de proposito: consultar status demorando
// tanto seria sinal de problema, e afrouxar isso nos cegaria.
// Retentar e seguro -- se a Meta ja publicou, a proxima rodada le PUBLISHED e
// nao republica. Verificado em 1.905 publicacoes, zero duplicata.
const metaPublishTimeoutMs = 60_000;
const maxConcurrentMetaRequests = integerEnv('PUBLICATION_WORKER_META_CONCURRENCY', 5, 1, 20);
const zernioBaseUrl = process.env.ZERNIO_API_BASE_URL ?? 'https://zernio.com/api';
const zernioRequestTimeoutMs = integerEnv('ZERNIO_REQUEST_TIMEOUT_MS', 45_000, 25_000, 90_000);
// TETO Nº 1 da fila, e o unico que ainda morde. `paceZernioCreate` serializa as
// criacoes: cada uma comeca ao menos `spacingMs` depois da anterior, no processo
// inteiro.
//
//   75 ms -> 13,3/s ->   800/min   <- medimos 736/min = 92% do teto
//   40 ms -> 25,0/s -> 1.500/min
//
// A folga do PROVEDOR existe e e grande: o limite real da Zernio e 25 posts/hora
// por conta, e o pico medido foi 4/hora - 16% do teto dela, sobrando ~6x. O que
// sobe aqui e a concorrencia contra o nosso proprio banco, nao contra a Zernio.
//
// Continua sendo um portao POR PROCESSO: se um dia 1.500/min nao bastar, a saida
// e mais de um publicador (workerId distinto), nao baixar isso indefinidamente.
// Ver docs/fila-de-publicacao-mapa-de-controles.md, secao 4.
const zernioCreateMinimumSpacingMs = integerEnv('PUBLICATION_WORKER_ZERNIO_CREATE_SPACING_MS', 40, 0, 2_000);
const zernioCreateBackpressureSpacingMs = integerEnv('PUBLICATION_WORKER_ZERNIO_BACKPRESSURE_SPACING_MS', 200, 25, 5_000);
// Era 5 minutos fixos. Ver o comentario de activateZernioBackpressure.
const zernioBackpressureDurationMs = integerEnv('PUBLICATION_WORKER_ZERNIO_BACKPRESSURE_MS', 60_000, 5_000, 600_000);
const zernioBackpressureFailureThreshold = integerEnv('PUBLICATION_WORKER_ZERNIO_BACKPRESSURE_THRESHOLD', 3, 1, 50);
const zernioBackpressureFailureWindowMs = integerEnv('PUBLICATION_WORKER_ZERNIO_BACKPRESSURE_WINDOW_MS', 60_000, 5_000, 600_000);
const mediaProbeTimeoutMs = integerEnv('PUBLICATION_MEDIA_URL_PROBE_TIMEOUT_MS', 12_000, 1_000, 30_000);
const zernioMediaRetryWindowSeconds = integerEnv('PUBLICATION_ZERNIO_MEDIA_RETRY_WINDOW_SECONDS', 600, 180, 1_800);

let activeMetaRequests = 0;
const pendingMetaRequests = [];
const zernioTelemetry = new Map();
const zernioTelemetryAnomalies = [];
let nextZernioCreateStartAt = 0;
let zernioBackpressureUntil = 0;
let zernioRecentFailures = [];

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

const transientSupabaseHttpStatuses = new Set([502, 503, 504, 521, 522, 523, 524]);

async function supabaseFetch(input, init) {
  let response;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await fetch(input, init);
    if (!transientSupabaseHttpStatuses.has(response.status) || attempt === 2) return response;
    await response.body?.cancel().catch(() => undefined);
    await wait(150 * (2 ** attempt) + Math.floor(Math.random() * 151));
  }
  return response;
}

function createSupabase() {
  return createClient(requiredEnv('NEXT_PUBLIC_SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: supabaseFetch },
  });
}

function encryptionKey() {
  const key = Buffer.from(requiredEnv('TOKEN_ENCRYPTION_KEY'), 'base64');
  if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY deve conter exatamente 32 bytes em Base64.');
  return key;
}

function decryptToken(payload) {
  const [version, ivValue, tagValue, encryptedValue] = payload.split('.');
  if (version !== 'v1' || !ivValue || !tagValue || !encryptedValue) throw new Error('Token criptografado inválido.');

  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function graphUrl(path) {
  return `https://graph.instagram.com/${graphVersion}/${path.replace(/^\//, '')}`;
}

// LOG POR FASE (15/09/2026). Ate aqui o caminho direto so media `porItemMs`, o
// tempo total de cada item, e esse numero mistura coisas de donos diferentes:
// espera pela vaga no semaforo da Meta, a chamada HTTP em si, a sonda do R2, as
// RPCs do banco. O mestre (secao 10) registra que "um porItemMs alto nao e Meta
// lenta ate que o log por fase diga". Cada item carrega um livro-razao de fases
// via AsyncLocalStorage, para que metaFetch, a sonda e as RPCs registrem o seu
// tempo sem mudar assinatura de funcao. O ciclo agrega por fase (p50/p90/max) e
// mede a ociosidade do lote: quanto tempo cada vaga ficou parada esperando o
// item mais lento (`Promise.allSettled`), que e o defeito do lote da secao 8.3.
// Nada aqui altera decisao alguma: e leitura.
const fasesDoItem = new AsyncLocalStorage();

export function registrarFase(nome, ms) {
  const livro = fasesDoItem.getStore();
  if (!livro || !Number.isFinite(ms)) return;
  livro[nome] = (livro[nome] ?? 0) + Math.max(0, Math.round(ms));
}

export async function medirFase(nome, operacao) {
  const inicio = Date.now();
  try {
    return await operacao();
  } finally {
    registrarFase(nome, Date.now() - inicio);
  }
}

export function comFasesDoItem(livro, operacao) {
  return fasesDoItem.run(livro, operacao);
}

function quantis(valores) {
  const o = [...valores].sort((a, b) => a - b);
  const q = (p) => o[Math.min(o.length - 1, Math.floor(o.length * p))];
  return { n: o.length, p50: Math.round(q(0.5)), p90: Math.round(q(0.9)), max: Math.round(o[o.length - 1]) };
}

// Resume os livros-razao de um ciclo: por fase, quantos itens passaram por ela e
// p50/p90/max em ms. Fase ausente num item nao entra no denominador daquela fase.
export function resumirFasesPorItem(livros) {
  const porFase = new Map();
  for (const livro of livros) {
    if (!livro || typeof livro !== 'object') continue;
    for (const [fase, ms] of Object.entries(livro)) {
      if (!Number.isFinite(ms)) continue;
      if (!porFase.has(fase)) porFase.set(fase, []);
      porFase.get(fase).push(ms);
    }
  }
  const resumo = {};
  for (const [fase, valores] of [...porFase.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    resumo[fase] = quantis(valores);
  }
  return resumo;
}

// Ociosidade do lote: para cada item, quanto tempo a vaga dele ficou parada entre
// o fim do item e o fim do lote. `aproveitamento` e a fracao do tempo de vaga
// realmente usada (soma das duracoes / (itens x duracao do lote)); 1,0 seria uma
// janela deslizante perfeita, e o que falta para 1,0 e o custo do lote inteiro.
export function ociosidadeDoLote(duracoesMs, terminosMs, fimDoLoteMs) {
  if (!duracoesMs.length || duracoesMs.length !== terminosMs.length) return null;
  const ociosos = terminosMs.map((fim) => Math.max(0, fimDoLoteMs - fim));
  const loteMs = Math.max(1, Math.max(...duracoesMs));
  const usado = duracoesMs.reduce((soma, ms) => soma + ms, 0);
  const capacidade = duracoesMs.length * loteMs;
  return {
    ...quantis(ociosos),
    somaSegundos: Math.round(ociosos.reduce((soma, ms) => soma + ms, 0) / 1000),
    aproveitamento: Number((usado / capacidade).toFixed(2)),
  };
}

async function withMetaRequestLimit(operation) {
  if (activeMetaRequests >= maxConcurrentMetaRequests) {
    const esperaDesde = Date.now();
    await new Promise((resolve) => pendingMetaRequests.push(resolve));
    registrarFase('esperaSemaforoMeta', Date.now() - esperaDesde);
  }
  activeMetaRequests += 1;
  try {
    return await operation();
  } finally {
    activeMetaRequests -= 1;
    pendingMetaRequests.shift()?.();
  }
}

// `operacao` existe porque um timeout sem rotulo nao diz nada. Em 04/09/2026
// apareceram 112 falhas com "The operation was aborted due to timeout" e nao
// havia como saber se estourava ao CRIAR o conteiner, ao CONSULTAR o status ou
// ao PUBLICAR -- e sem isso qualquer ajuste no limite de 25 s seria chute.
function metaFetch(input, init, operacao = 'meta', limiteMs = metaRequestTimeoutMs) {
  return withMetaRequestLimit(async () => {
    const inicio = Date.now();
    try {
      return await fetch(input, init);
    } catch (error) {
      const expirou = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      if (!expirou) throw error;
      const rotulado = new Error(`Tempo esgotado ao ${operacao} na Meta (limite de ${limiteMs / 1000}s).`);
      rotulado.retryable = true;
      rotulado.code = `meta_timeout_${operacao}`;
      throw rotulado;
    } finally {
      registrarFase(`meta_${operacao}`, Date.now() - inicio);
    }
  });
}

function wait(milliseconds) {
  return milliseconds > 0 ? new Promise((resolve) => setTimeout(resolve, milliseconds)) : Promise.resolve();
}

export async function paceZernioCreate(operation, options = {}) {
  const now = Date.now();
  const normalSpacingMs = options.normalSpacingMs ?? zernioCreateMinimumSpacingMs;
  const backpressureSpacingMs = options.backpressureSpacingMs ?? zernioCreateBackpressureSpacingMs;
  const spacingMs = now < zernioBackpressureUntil ? backpressureSpacingMs : normalSpacingMs;
  const scheduledAt = Math.max(now, nextZernioCreateStartAt);
  nextZernioCreateStartAt = scheduledAt + spacingMs;
  await wait(scheduledAt - now);
  return operation();
}

// MEDIDO EM PRODUCAO (30/08/2026), 2h de telemetria: 6.777 requisicoes a Zernio,
// das quais 44 falharam (35 network_error, 6 timeout, 3 http_error) - 0,5%, taxa
// normal para HTTP. Mas a versao anterior desta funcao ligava o backpressure por
// 5 MINUTOS a cada UMA dessas falhas, e o backpressure derruba o teto do portao
// serializado de 800/min para 300/min.
//
// Com uma falha a cada 2,7 minutos e punicao de 5 minutos, o remedio ficou mais
// caro que a doenca: o teto efetivo passava a maior parte do tempo na metade,
// por causa de 0,5% de erro transitorio. Para 5.000 perfis (que exigem 500/min
// numa janela de 10 min), a diferenca entre 800 e 300 e a diferenca entre caber
// e nao caber.
//
// A protecao continua, proporcional ao que o erro realmente significa:
//
//   429  -> o provedor disse EXPLICITAMENTE "pare". Liga na hora, sem contar.
//           Nao se negocia com rate limit declarado.
//   resto -> timeout, erro de rede e 5xx podem ser blip transitorio, inclusive
//           da nossa ponta. So ligam quando se repetem: N falhas dentro de uma
//           janela curta. Se o problema for real e continuo, a janela reenche e
//           o backpressure se renova sozinho - a punicao passa a acompanhar a
//           TAXA de erro em vez de latir por um evento isolado.
export function shouldActivateZernioBackpressure(error, recentFailures, threshold) {
  if (!error) return false;
  if (error?.httpStatus === 429) return true;
  const outcome = zernioOutcome(error);
  const transiente = outcome === 'timeout'
    || outcome === 'network_error'
    || (Number.isInteger(error?.httpStatus) && error.httpStatus >= 500);
  if (!transiente) return false;
  return recentFailures >= threshold;
}

function activateZernioBackpressure(error) {
  const now = Date.now();
  zernioRecentFailures = zernioRecentFailures.filter(
    (at) => now - at < zernioBackpressureFailureWindowMs,
  );
  if (error?.httpStatus !== 429) zernioRecentFailures.push(now);

  if (!shouldActivateZernioBackpressure(error, zernioRecentFailures.length, zernioBackpressureFailureThreshold)) {
    return;
  }
  zernioBackpressureUntil = Math.max(zernioBackpressureUntil, now + zernioBackpressureDurationMs);
  zernioRecentFailures = [];
  // console.info, nao console.warn: warn vai para o log de ERRO do PM2, e o
  // tamanho desse log e o sinal de saude usado para decidir rollback. Ativacao
  // de backpressure e informacao operacional esperada, nao falha - poluir o
  // canal de erro com ela cega justamente o alarme que importa.
  console.info('[publication-worker] backpressure Zernio ativado', {
    motivo: error?.httpStatus === 429 ? 'http_429_explicito' : 'falhas_transitorias_repetidas',
    httpStatus: error?.httpStatus ?? null,
    duracaoMs: zernioBackpressureDurationMs,
  });
}

function zernioTelemetryBucket(durationMs) {
  if (durationMs < 250) return 'lt_250ms';
  if (durationMs < 1000) return '250ms_1s';
  if (durationMs < 5000) return '1s_5s';
  if (durationMs < 15000) return '5s_15s';
  if (durationMs < zernioRequestTimeoutMs) return '15s_timeout';
  return 'timeout_plus';
}

export function sanitizedZernioDiagnostic(value, maximum = 600) {
  if (!value) return null;
  return String(value)
    .replace(/https?:\/\/[^\s"']+/gi, '[URL ocultada]')
    .replace(/bearer\s+[^\s"']+/gi, 'Bearer [oculto]')
    .slice(0, maximum);
}

export function recordZernioRequestTelemetry(context, outcome, durationMs, error = null) {
  const operation = typeof context?.operation === 'string' && context.operation.trim()
    ? context.operation.trim().slice(0, 80)
    : 'unknown';
  const windowStartedAt = new Date(Math.floor(Date.now() / 300_000) * 300_000).toISOString();
  const key = [windowStartedAt, context.organizationId, context.connectionId ?? '', operation, outcome].join('|');
  const bucket = zernioTelemetryBucket(durationMs);
  const current = zernioTelemetry.get(key) ?? {
    window_started_at: windowStartedAt,
    organization_id: context.organizationId,
    zernio_connection_id: context.connectionId ?? null,
    operation,
    outcome,
    request_count: 0,
    duration_sum_ms: 0,
    duration_min_ms: durationMs,
    duration_max_ms: durationMs,
    latency_histogram: {},
  };
  current.request_count += 1;
  current.duration_sum_ms += durationMs;
  current.duration_min_ms = Math.min(current.duration_min_ms, durationMs);
  current.duration_max_ms = Math.max(current.duration_max_ms, durationMs);
  current.latency_histogram[bucket] = (current.latency_histogram[bucket] ?? 0) + 1;
  zernioTelemetry.set(key, current);

  if (outcome !== 'succeeded' && zernioTelemetryAnomalies.length < 200) {
    zernioTelemetryAnomalies.push({
      occurred_at: new Date().toISOString(),
      organization_id: context.organizationId,
      zernio_connection_id: context.connectionId ?? null,
      publication_item_id: context.itemId ?? null,
      batch_id: context.batchId ?? null,
      correlation_id: context.correlationId ?? null,
      operation,
      outcome,
      duration_ms: durationMs,
      timeout_ms: zernioRequestTimeoutMs,
      http_status: Number.isInteger(error?.httpStatus) ? error.httpStatus : null,
      provider_code: sanitizedZernioDiagnostic(error?.code, 120),
      provider_request_id: sanitizedZernioDiagnostic(error?.requestId, 240),
      error_message: sanitizedZernioDiagnostic(error?.message),
      attempt_count: Number.isInteger(context.attemptCount) ? context.attemptCount : null,
    });
  }
}

export function zernioOutcome(error) {
  if (!error) return 'succeeded';
  if (error?.name === 'TimeoutError') return 'timeout';
  if (Number.isInteger(error?.httpStatus)) return 'http_error';
  if (error instanceof SyntaxError) return 'parse_error';
  return 'network_error';
}

export async function flushZernioRequestTelemetry(options = {}) {
  if (zernioTelemetry.size === 0 && zernioTelemetryAnomalies.length === 0) return { flushed: 0, anomalies: 0 };
  const rollups = [...zernioTelemetry.values()];
  const anomalies = zernioTelemetryAnomalies.splice(0, zernioTelemetryAnomalies.length);
  zernioTelemetry.clear();
  try {
    const supabase = (options.createSupabase ?? createSupabase)();
    const { error } = await supabase.rpc('record_zernio_publication_request_telemetry', {
      p_rollups: rollups,
      p_anomalies: anomalies,
    });
    if (error) throw error;
    return { flushed: rollups.length, anomalies: anomalies.length };
  } catch (error) {
    console.error('Telemetria Zernio descartada sem bloquear a fila.', errorInfo(error));
    return { flushed: 0, anomalies: 0, discarded: rollups.length, discardedAnomalies: anomalies.length };
  }
}

function publicationDataError(message, code = 'invalid_publication_data') {
  const error = new Error(message);
  error.retryable = false;
  error.code = code;
  return error;
}

function invalidWorkItem(message) {
  return { state: 'failed', retryable: false, errorCode: 'invalid_work_item', errorMessage: message };
}

function removedWorkItem(message = 'Mídia apagada.') {
  return { state: 'removed', retryable: false, errorCode: 'media_deleted', errorMessage: message };
}

function suspendedWorkItem(message = 'Perfil offline; retomada manual necessária.') {
  return { state: 'suspended', retryable: false, errorCode: 'profile_offline_suspended', errorMessage: message };
}

function errorInfo(error) {
  if (error instanceof Error) {
    return {
      code: sanitizedZernioDiagnostic(error.code, 120),
      message: sanitizedZernioDiagnostic(error.message, 1200),
      stack: sanitizedZernioDiagnostic(error.stack, 2000),
    };
  }
  if (error && typeof error === 'object') {
    return {
      code: sanitizedZernioDiagnostic(error.code, 120),
      message: sanitizedZernioDiagnostic(error.message, 1200),
      details: sanitizedZernioDiagnostic(error.details, 1200),
      hint: sanitizedZernioDiagnostic(error.hint, 500),
    };
  }
  return { message: sanitizedZernioDiagnostic(String(error), 1200) };
}

// Assinaturas de falha de TRANSPORTE (undici/Node).
//
// Elas precisam estar aqui porque o supabase-js NAO propaga o TypeError original
// de uma queda de rede: ele entrega um objeto simples
// `{ message: 'TypeError: fetch failed', details, hint, code: '' }`. Como isso
// nao e instancia de Error, o `error instanceof TypeError` abaixo passa longe, e
// "fetch failed" nao batia com nenhum termo da lista de mensagens.
//
// O CUSTO DISSO, MEDIDO EM PRODUCAO (31/08/2026 15:19 UTC ate 01/09 11:00 UTC):
// uma queda de conexao com o Supabase virava falha TERMINAL de publicacao, com
// `retryable: false` ja na primeira tentativa. 3.315 posts perdidos em 946
// perfis, nenhum deles reprocessavel sozinho, com taxa de perda chegando a 19,7%
// em uma hora. Era exatamente o que o comentario dentro de
// `recoverUnexpectedDispatcherFailure` diz que nunca pode acontecer.
//
// POR QUE AMPLIAR AQUI NAO ARRISCA POSTAGEM DUPLICADA: falha de transporte
// contra a Zernio nao chega ao catch-all. `zernioFailureResult` a converte antes
// em `zernio_creation_outcome_unknown`, que e terminal de proposito, justamente
// porque nesse caso nao se sabe se o post foi criado. O catch-all so ve erro que
// escapou de todo o fluxo normal — na pratica, o banco.
const TRANSPORT_FAILURE = /fetch failed|und_err_|connecttimeouterror|headerstimeouterror|bodytimeouterror|socketerror|socket hang up|econnreset|econnrefused|etimedout|eai_again|enotfound|epipe/;

// Pagina de erro do GATEWAY na frente da API do Supabase (Cloudflare 52x/5xx).
// Quando o Postgres reinicia (troca de compute, upgrade), o supabase-js recebe
// um HTML inteiro como `message`, com `code: null` -- nenhuma assinatura acima
// bate. MEDIDO EM 07/09/2026 23:36Z, na reducao XL -> Medium: dois itens ja
// PUBLICADOS na Meta viraram falha terminal "dispatcher_unexpected_error" com
// "<!DOCTYPE html>... 521: Web server is down" gravado como motivo. Com esta
// assinatura o item e adiado 30 s e, na volta, o conteiner PUBLISHED e
// reconhecido (`already_published`) sem segunda publicacao.
const GATEWAY_FAILURE = /<!doctype html|<html|web server is down|bad gateway|gateway time-?out|service unavailable|error code 5\d\d|cloudflare/;

export function isPublicationInfrastructureError(error) {
  const details = errorInfo(error);
  const code = String(details.code ?? '').trim().toLowerCase();
  const message = [details.message, details.details, details.hint].filter(Boolean).join(' ').toLowerCase();
  return error instanceof TypeError || new Set([
    '57014', '40001', '40p01', '53300', '57p01', '57p02', '57p03', '55p03',
    'publication_worker_cycle_failed',
  ]).has(code)
    || /statement timeout|canceling statement|deadlock detected|connection pool|database connection|supabase unavailable/.test(message)
    || TRANSPORT_FAILURE.test(message)
    || GATEWAY_FAILURE.test(message);
}

function storageSignedUrlError(error) {
  const details = error && typeof error === 'object' ? error : {};
  const message = typeof details.message === 'string' ? details.message : '';
  const status = Number(details.statusCode ?? details.status);
  const missingObject = status === 404 || /object not found/i.test(message);
  const typed = new Error(missingObject
    ? 'Arquivo da mídia não encontrado no Storage. Reenvie a mídia na galeria antes de publicar.'
    : 'Não foi possível criar URL temporária da mídia.');
  typed.retryable = !missingObject;
  typed.code = missingObject ? 'media_storage_object_missing' : 'storage_signed_url_failed';
  return typed;
}

export async function createTemporaryUrl(storagePath) {
  if (mediaStorageBackend() === 'r2') {
    const bucket = process.env.R2_BUCKET_INSTAGRAM_MEDIA || 'instagram-media';
    try {
      const [{ GetObjectCommand }, { getSignedUrl }, client] = await Promise.all([
        import('@aws-sdk/client-s3'),
        import('@aws-sdk/s3-request-presigner'),
        getR2Client(),
      ]);
      return await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: storagePath }), { expiresIn: 60 * 60 * 24 });
    } catch (error) {
      throw storageSignedUrlError(error);
    }
  }
  const supabase = createSupabase();
  const { data, error } = await supabase.storage.from('instagram-media').createSignedUrl(storagePath, 60 * 60 * 24);
  if (error || !data?.signedUrl) throw storageSignedUrlError(error);
  return data.signedUrl;
}

export function mediaDeliveryError(message, code, retryable = true) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  return error;
}

export function urlFingerprint(url) {
  return createHash('sha256').update(url).digest('hex');
}

export function expectedMediaMime(kind, contentType) {
  return kind === 'video' ? /^video\//i.test(contentType) : /^image\//i.test(contentType);
}

function parsedContentRange(value) {
  const match = String(value ?? '').match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
  if (!match) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === '*' ? null : Number(match[3]),
  };
}

export async function probeMediaUrl(url, kind, options = {}) {
  const fetchImpl = options.fetch ?? fetch;
  const startedAt = Date.now();
  const probe = async (method, range = null) => {
    const response = await fetchImpl(url, {
      method,
      headers: range ? { Range: range } : undefined,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(mediaProbeTimeoutMs),
    });
    const contentType = response.headers.get('content-type') ?? '';
    const contentRange = parsedContentRange(response.headers.get('content-range'));
    const contentLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
    const cacheStatus = response.headers.get('cf-cache-status') ?? response.headers.get('x-cache') ?? null;
    await response.body?.cancel().catch(() => undefined);
    return {
      response,
      contentType,
      contentRange,
      contentLength: Number.isFinite(contentLength) ? contentLength : null,
      cacheStatus,
    };
  };

  let head;
  try {
    head = await probe('HEAD');
  } catch (error) {
    if (error?.name === 'TimeoutError') throw mediaDeliveryError('A verificação externa da URL da mídia expirou.', 'media_url_probe_timeout');
    throw mediaDeliveryError('Não foi possível verificar externamente a URL da mídia.', 'media_url_probe_network');
  }

  let first;
  try {
    first = await probe('GET', 'bytes=0-1023');
  } catch (error) {
    if (error?.name === 'TimeoutError') throw mediaDeliveryError('A leitura parcial da URL da mídia expirou.', 'media_url_range_probe_timeout');
    throw mediaDeliveryError('Não foi possível ler externamente a URL da mídia.', 'media_url_range_probe_network');
  }

  if (!first.response.ok) throw mediaDeliveryError(`A URL temporária da mídia retornou HTTP ${first.response.status}.`, `media_url_probe_http_${first.response.status}`, first.response.status >= 500);
  if (!expectedMediaMime(kind, first.contentType || head.contentType)) throw mediaDeliveryError('A URL temporária retornou um tipo de conteúdo incompatível com a mídia.', 'media_url_probe_mime_invalid', false);
  if (kind === 'video' && (first.response.status !== 206 || !first.contentRange || first.contentRange.start !== 0)) {
    throw mediaDeliveryError('O host da mídia não confirmou leitura parcial do vídeo.', 'media_url_range_unsupported', false);
  }

  const totalBytes = first.contentRange?.total ?? (Number.isFinite(head.contentLength) ? head.contentLength : null);
  let last = null;
  if (kind === 'video' && totalBytes && totalBytes > 1024) {
    try {
      last = await probe('GET', 'bytes=-1024');
    } catch (error) {
      if (error?.name === 'TimeoutError') throw mediaDeliveryError('A leitura final da URL da mídia expirou.', 'media_url_tail_probe_timeout');
      throw mediaDeliveryError('Não foi possível ler o final da URL da mídia.', 'media_url_tail_probe_network');
    }
    if (last.response.status !== 206 || !last.contentRange || last.contentRange.total !== totalBytes || last.contentRange.end !== totalBytes - 1) {
      // RETRYAVEL, e com o que o host respondeu. Em 08 e 09/09/2026 quatro reels
      // morreram aqui como terminais; os quatro arquivos ja tinham publicado de 81
      // a 648 vezes cada e publicaram de novo minutos depois. Era o R2/CDN num
      // instante, nao o arquivo -- e sem o status/range no motivo nao havia como
      // saber. O recuo da 420 (30 s) resolve; encerrar custava o post.
      const range = last.contentRange
        ? `${last.contentRange.start}-${last.contentRange.end}/${last.contentRange.total ?? '*'}`
        : 'ausente';
      throw mediaDeliveryError(
        `O host não entregou corretamente o final do vídeo (HTTP ${last.response.status}, content-range ${range}, esperado ${totalBytes - 1}/${totalBytes}, cache ${last.cacheStatus ?? 'n/d'}).`,
        'media_url_tail_range_invalid',
        true,
      );
    }
  }

  return {
    url,
    fingerprint: urlFingerprint(url),
    httpStatus: first.response.status,
    contentType: first.contentType || head.contentType,
    contentLength: totalBytes,
    probeDurationMs: Date.now() - startedAt,
    cacheStatus: last?.cacheStatus ?? first.cacheStatus ?? head.cacheStatus,
  };
}

async function recordMediaDeliveryAttempt(item, media, phase, outcome, details = {}) {
  const supabase = createSupabase();
  const { error } = await supabase.rpc('record_media_asset_delivery_attempt', {
    p_media_asset_id: media.id,
    p_publication_item_id: item.id,
    p_provider: item.profile.provider,
    p_phase: phase,
    p_outcome: outcome,
    p_error_code: details.errorCode ?? null,
    p_error_message: details.errorMessage ?? null,
    p_url_fingerprint: details.urlFingerprint ?? null,
  });
  if (error) throw error;
}

async function latestProviderUrlFingerprint(item, media) {
  const supabase = createSupabase();
  const { data, error } = await supabase
    .from('media_asset_delivery_attempts')
    .select('url_fingerprint')
    .eq('publication_item_id', item.id)
    .eq('media_asset_id', media.id)
    .eq('phase', 'url_probe')
    .eq('outcome', 'succeeded')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.url_fingerprint ?? null;
}

export async function buildVerifiedMediaUrls(item, options = {}) {
  const createUrl = options.createTemporaryUrl ?? createTemporaryUrl;
  const probeUrl = options.probeMediaUrl ?? probeMediaUrl;
  const recordAttempt = options.recordMediaDeliveryAttempt ?? recordMediaDeliveryAttempt;
  return Promise.all(item.media.map(async (media) => {
    let probe;
    let emittedUrl;
    let emittedUrlFingerprint;
    try {
      emittedUrl = await createUrl(media.storage_path);
      emittedUrlFingerprint = urlFingerprint(emittedUrl);
      probe = await probeUrl(emittedUrl, media.kind);
      await recordAttempt(item, media, 'url_probe', 'succeeded', { urlFingerprint: probe.fingerprint });
      return probe.url;
    } catch (error) {
      await recordAttempt(item, media, 'url_probe', 'failed', {
        errorCode: error.code ?? 'media_url_probe_failed',
        errorMessage: error.message ?? 'A URL temporária da mídia não pôde ser validada.',
        urlFingerprint: probe?.fingerprint ?? emittedUrlFingerprint ?? null,
      }).catch((recordError) => console.error('Falha ao registrar diagnóstico de entrega de mídia.', errorInfo(recordError)));
      throw error;
    }
  }));
}

async function readInstagramResponse(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body.error?.message ?? `Instagram retornou HTTP ${response.status}.`;
    const error = new Error(message);
    // 9004 "Only photo or video can be accepted as media type" e a Meta falhando
    // ao BUSCAR a midia, nao a midia errada (ver META_MEDIA_FETCH_ERROR_CODE).
    // A regra ja existia em lib/integrations/meta-graph-errors.ts, mas so o
    // despachante da Vercel a usava; este worker nunca. Em 09/09/2026 dois PNG
    // que ja tinham publicado 1.397 e 1.100 vezes morreram aqui na primeira
    // leitura. Retentar custa uma tentativa; encerrar custa o story do dia.
    // 9007 "Media ID is not available" vem no PUBLICAR depois de FINISHED: a
    // midia ainda nao esta pronta do lado da Meta (10/09/2026, arquivo que ja
    // tinha publicado 636 vezes). Retentar consulta o conteiner de novo.
    error.retryable = response.status >= 500 || response.status === 429 || body.error?.is_transient === true
      || Number(body.error?.code) === META_MEDIA_FETCH_ERROR_CODE
      || Number(body.error?.code) === META_MEDIA_NOT_AVAILABLE_ERROR_CODE;
    error.code = String(body.error?.code ?? response.status);
    error.httpStatus = response.status;
    error.errorSubcode = Number.isInteger(body.error?.error_subcode) ? body.error.error_subcode : null;
    error.errorType = typeof body.error?.type === 'string' ? body.error.type : null;
    error.fbtraceId = typeof body.error?.fbtrace_id === 'string' ? body.error.fbtrace_id : null;
    throw error;
  }
  return body;
}

async function createInstagramContainer(profileId, accessToken, fields) {
  const response = await metaFetch(graphUrl(`${encodeURIComponent(profileId)}/media`), {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
    cache: 'no-store',
    signal: AbortSignal.timeout(metaRequestTimeoutMs),
  }, 'criar_container');
  const result = await readInstagramResponse(response);
  if (!result.id) throw new Error('Instagram não retornou o creation_id do contêiner.');
  return result.id;
}

async function containerStatus(creationId, accessToken) {
  const url = new URL(graphUrl(encodeURIComponent(creationId)));
  // `status` junto: e o campo que traz o motivo em texto. Pedir so o
  // `status_code` foi o que deixou 76 falhas de 04/09 sem nenhuma explicacao.
  url.searchParams.set('fields', 'status_code,status');
  const response = await metaFetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(metaRequestTimeoutMs),
  }, 'consultar_status');
  return readInstagramResponse(response);
}

async function publishInstagramContainer(profileId, creationId, accessToken) {
  const response = await metaFetch(graphUrl(`${encodeURIComponent(profileId)}/media_publish`), {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ creation_id: creationId }),
    cache: 'no-store',
    signal: AbortSignal.timeout(metaPublishTimeoutMs),
  }, 'publicar', metaPublishTimeoutMs);
  const result = await readInstagramResponse(response);
  if (!result.id) throw new Error('Instagram não retornou o media_id publicado.');
  return result.id;
}

async function createParentContainer(item, accessToken) {
  if (item.media.length === 0) throw publicationDataError('O item da publicação não possui mídia vinculada.');
  if (item.format === 'carousel' && (item.media.length < 2 || item.media.length > 10)) throw publicationDataError('O carrossel deve possuir entre 2 e 10 mídias.');
  if (item.format !== 'carousel' && item.media.length !== 1) throw publicationDataError('Este formato de publicação requer exatamente uma mídia.');

  const urls = await medirFase('sondaMidia', () => buildVerifiedMediaUrls(item));
  if (item.format === 'image') {
    if (item.media[0].kind !== 'image') throw publicationDataError('Uma publicação de imagem requer arquivo de imagem.');
    return createInstagramContainer(item.profile.instagram_user_id, accessToken, { image_url: urls[0], caption: item.caption ?? '' });
  }
  if (item.format === 'reel') {
    if (item.media[0].kind !== 'video') throw publicationDataError('Um Reel requer arquivo de vídeo.');
    return createInstagramContainer(item.profile.instagram_user_id, accessToken, { media_type: 'REELS', video_url: urls[0], caption: item.caption ?? '', share_to_feed: 'true' });
  }
  if (item.format === 'story') {
    const media = item.media[0];
    return createInstagramContainer(item.profile.instagram_user_id, accessToken, media.kind === 'video'
      ? { media_type: 'STORIES', video_url: urls[0] }
      : { media_type: 'STORIES', image_url: urls[0] });
  }

  const children = await Promise.all(item.media.map((media, index) => createInstagramContainer(item.profile.instagram_user_id, accessToken, media.kind === 'video'
    ? { media_type: 'VIDEO', video_url: urls[index], is_carousel_item: 'true' }
    : { image_url: urls[index], is_carousel_item: 'true' })));
  return createInstagramContainer(item.profile.instagram_user_id, accessToken, { media_type: 'CAROUSEL', children: children.join(','), caption: item.caption ?? '' });
}

async function processInstagramPublication(item, beforePublish, beforeProviderRequest) {
  try {
    if (!item.profile.encrypted_access_token) throw publicationDataError('Perfil Meta sem token de acesso. Reconecte o perfil.', 'missing_meta_access_token');
    const accessToken = decryptToken(item.profile.encrypted_access_token);
    if (beforeProviderRequest && !await beforeProviderRequest()) return suspendedWorkItem();
    if (!item.creation_id) return { state: 'processing', creationId: await createParentContainer(item, accessToken) };

    const status = await containerStatus(item.creation_id, accessToken);
    const veredito = metaContainerVerdict(status.status_code, status.status);
    if (veredito.kind === 'publish') {
      if (beforePublish && !await beforePublish()) return { state: 'deferred', reason: 'daily_profile_limit' };
      return { state: 'published', metaMediaId: await publishInstagramContainer(item.profile.instagram_user_id, item.creation_id, accessToken) };
    }
    if (veredito.kind === 'already_published') return { state: 'published', metaMediaId: null, recovered: true };
    if (veredito.kind === 'fail') {
      return { state: 'failed', retryable: veredito.retryable, errorCode: status.status_code, errorMessage: veredito.message };
    }
    if (!status.status_code) {
      const error = new Error('Instagram não retornou o status do contêiner.');
      error.retryable = true;
      error.code = 'missing_container_status';
      throw error;
    }
    return { state: 'processing', creationId: item.creation_id };
  } catch (error) {
    return {
      state: 'failed',
      retryable: error.retryable ?? true,
      errorCode: error.code ?? 'instagram_request_failed',
      errorMessage: (error.message || 'Falha desconhecida ao comunicar com o Instagram.').slice(0, 1200),
      providerDiagnostic: {
        errorSubcode: error.errorSubcode ?? null,
        errorType: error.errorType ?? null,
        httpStatus: error.httpStatus ?? null,
        fbtraceId: error.fbtraceId ?? null,
      },
    };
  }
}

function zernioUrl(path, query) {
  const url = new URL(`${zernioBaseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }
  return url;
}

async function readZernioResponse(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const nestedError = body?.error && typeof body.error === 'object' && !Array.isArray(body.error) ? body.error : null;
    const message = typeof body.error === 'string'
      ? body.error
      : typeof body.message === 'string'
        ? body.message
        : typeof nestedError?.message === 'string'
          ? nestedError.message
        : `Zernio retornou HTTP ${response.status}.`;
    const error = new Error(message);
    error.code = typeof body.code === 'string'
      ? body.code
      : typeof nestedError?.code === 'string'
        ? nestedError.code
        : String(response.status);
    error.httpStatus = response.status;
    error.retryable = response.status === 429 || response.status >= 500;
    error.details = body.details ?? nestedError?.details ?? null;
    error.existingPostId = body.existingPostId
      ?? body.details?.existingPostId
      ?? nestedError?.existingPostId
      ?? nestedError?.details?.existingPostId
      ?? null;
    error.requestId = response.headers.get('x-request-id') ?? response.headers.get('x-vercel-id');
    throw error;
  }
  return body;
}

function createZernioClient(apiKey, telemetryContext = null) {
  if (!apiKey.trim()) throw new Error('Chave da Zernio vazia.');
  async function request(path, options = {}) {
    const startedAt = Date.now();
    try {
      const executeFetch = () => fetch(zernioUrl(path, options.query), {
        method: options.method ?? (options.body ? 'POST' : 'GET'),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(options.requestId ? { 'x-request-id': options.requestId } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        cache: 'no-store',
        signal: AbortSignal.timeout(zernioRequestTimeoutMs),
      });
      const response = telemetryContext?.operation === 'create_post'
        ? await paceZernioCreate(executeFetch)
        : await executeFetch();
      const result = await readZernioResponse(response);
      if (telemetryContext) recordZernioRequestTelemetry(telemetryContext, 'succeeded', Date.now() - startedAt);
      return result;
    } catch (error) {
      activateZernioBackpressure(error);
      if (telemetryContext) recordZernioRequestTelemetry(telemetryContext, zernioOutcome(error), Date.now() - startedAt, error);
      // A etapa precisa acompanhar o erro até o dispatcher. Em create_post,
      // timeout/rede significam resultado externo desconhecido: a solicitação
      // pode ter sido aceita mesmo sem resposta ao worker.
      if (error && typeof error === 'object' && telemetryContext?.operation) {
        error.zernioOperation = telemetryContext.operation;
      }
      throw error;
    }
  }
  return {
    createPost(body, requestId) {
      return request('/v1/posts', { body, requestId });
    },
    getPost(postId) {
      return request(`/v1/posts/${encodeURIComponent(postId)}`);
    },
    updatePost(postId, body) {
      return request(`/v1/posts/${encodeURIComponent(postId)}`, { method: 'PUT', body });
    },
    retryPost(postId) {
      return request(`/v1/posts/${encodeURIComponent(postId)}/retry`, { method: 'POST' });
    },
    listPosts(query = {}) {
      return request('/v1/posts', { query });
    },
    disconnectAccount(accountId, requestId) {
      return request(`/v1/accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE', requestId });
    },
    listAccounts(query = {}) {
      return request('/v1/accounts', { query });
    },
  };
}

function zernioNotConfiguredError(message = 'A integração Zernio desta conta não está configurada.') {
  const typed = new Error(message);
  typed.retryable = false;
  typed.code = 'zernio_not_configured';
  return typed;
}

async function loadZernioConnection(organizationId, connectionId) {
  const supabase = createSupabase();
  const { data, error } = await supabase
    .from('zernio_connections')
    .select('id, organization_id, label, encrypted_api_key, zernio_profile_id, status')
    .eq('id', connectionId)
    .eq('organization_id', organizationId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error || !data?.encrypted_api_key) throw zernioNotConfiguredError('A conta Zernio selecionada não está configurada ou foi removida.');
  return data;
}

async function createZernioClientForConnection(organizationId, connectionId, telemetryContext = null) {
  const connection = await loadZernioConnection(organizationId, connectionId);
  return createZernioClient(decryptToken(connection.encrypted_api_key), {
    ...telemetryContext,
    operation: telemetryContext?.operation ?? 'unknown',
    organizationId,
    connectionId,
  });
}

async function createZernioClientForOrganization(organizationId, telemetryContext = null) {
  const supabase = createSupabase();
  const { data: connection, error: connectionError } = await supabase
    .from('zernio_connections')
    .select('encrypted_api_key')
    .eq('organization_id', organizationId)
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!connectionError && connection?.encrypted_api_key) return createZernioClient(decryptToken(connection.encrypted_api_key), {
    ...telemetryContext,
    operation: telemetryContext?.operation ?? 'unknown',
    organizationId,
    connectionId: null,
  });

  const { data, error } = await supabase
    .from('zernio_organization_settings')
    .select('encrypted_api_key')
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error || !data?.encrypted_api_key) throw zernioNotConfiguredError();
  return createZernioClient(decryptToken(data.encrypted_api_key), {
    ...telemetryContext,
    operation: telemetryContext?.operation ?? 'unknown',
    organizationId,
    connectionId: null,
  });
}

function zernioPostId(post) {
  return post?._id ?? post?.id ?? null;
}

function zernioRemoteId(value) {
  if (typeof value === 'string') return value;
  return value?._id ?? value?.id ?? value?.accountId ?? null;
}

function zernioPlatformEntry(post) {
  return post?.platforms?.find((entry) => entry.platform === 'instagram') ?? post?.platforms?.[0] ?? null;
}

function zernioPostMatchesWorkItem(post, item) {
  const platform = (post?.platforms ?? []).find((entry) => entry.platform === 'instagram'
    && zernioRemoteId(entry.accountId) === item.profile.zernio_account_id);
  if (!platform) return false;
  const remoteContentType = platform?.platformSpecificData?.contentType ?? null;
  if (item.format === 'story' && remoteContentType !== 'story') return false;
  if (item.format !== 'story' && remoteContentType === 'story') return false;
  const mediaUrls = (post?.mediaItems ?? []).map((media) => String(media?.url ?? ''));
  return item.media.length > 0 && item.media.every((media) => mediaUrls.some((url) => {
    try {
      const pathname = decodeURIComponent(new URL(url).pathname);
      return pathname.endsWith(`/${media.storage_path}`) || pathname.includes(`athena-${media.id}.`);
    } catch {
      return url.includes(media.storage_path) || url.includes(`athena-${media.id}.`);
    }
  }));
}

export function zernioExistingPostId(error) {
  const direct = error?.existingPostId;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const serialized = JSON.stringify(error?.details ?? {});
  return serialized.match(/"existingPostId"\s*:\s*"([^"]+)"/)?.[1] ?? null;
}

function normalizedStatus(value) {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function diagnosticText(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text
    .replace(/https?:\/\/[^\s"']+/gi, '[URL ocultada]')
    .replace(/bearer\s+[^\s"']+/gi, 'Bearer [oculto]')
    .slice(0, 700);
}

function zernioErrorMessage(error) {
  const parts = [error?.message || 'Falha desconhecida ao comunicar com a Zernio.'];
  const details = diagnosticText(error?.details);
  if (details) parts.push(`Detalhes da Zernio: ${details}`);
  if (error?.requestId) parts.push(`ID da requisição Zernio: ${error.requestId}`);
  return parts.join(' — ').slice(0, 1200);
}

function isProviderMediaDownloadFailure(result) {
  const text = `${result?.errorCode ?? ''} ${result?.errorMessage ?? ''}`.toLowerCase();
  return /download|media url|video.*url|host returned|couldn['’]?t fetch|cannot fetch/.test(text);
}

export function isZernioTerminalAccountDisconnection(result) {
  const value = [
    result?.errorCode,
    result?.errorMessage,
    result?.providerDiagnostic?.category,
    result?.providerDiagnostic?.providerCode,
  ].filter(Boolean).join(' ').toLowerCase();
  return /(^|[^a-z0-9])(account[_\s-]*disconnected|auth[_\s-]*expired)(?=$|[^a-z0-9])/.test(value);
}

export function isMetaTerminalProfileDisconnection(result) {
  const code = String(result?.errorCode ?? result?.code ?? '').trim();
  const errorSubcode = Number(result?.errorSubcode ?? result?.providerDiagnostic?.errorSubcode ?? NaN);
  const value = [
    result?.errorMessage,
    result?.message,
    result?.errorType,
    result?.providerDiagnostic?.errorType,
  ].filter(Boolean).join(' ').toLowerCase();

  if (code !== '190') return false;
  if ([458, 459, 460, 463, 464, 467].includes(errorSubcode)) return true;

  return /error validating access token|invalid(?:ated)? access token|session has been invalidated|log in to www\.instagram\.com|login to www\.instagram\.com|follow the instructions given|checkpoint/.test(value);
}

function zernioDisconnectionSignal(result) {
  const value = [result?.errorCode, result?.errorMessage, result?.providerDiagnostic?.category, result?.providerDiagnostic?.providerCode]
    .filter(Boolean).join(' ').toLowerCase();
  return /auth[_\s-]*expired/.test(value) ? 'auth_expired' : 'account_disconnected';
}

export function zernioFailureResult(error) {
  const creationOutcomeUnknown = error?.zernioOperation === 'create_post'
    && (
      (Number.isInteger(error?.httpStatus) && error.httpStatus >= 500)
      || (!Number.isInteger(error?.httpStatus)
        && ['timeout', 'network_error', 'parse_error'].includes(zernioOutcome(error)))
    );

  if (creationOutcomeUnknown) {
    return {
      state: 'failed',
      retryable: false,
      errorCode: 'zernio_creation_outcome_unknown',
      errorMessage: 'A criação Zernio não retornou confirmação. Para evitar postagem duplicada, nenhuma nova criação será enviada automaticamente.',
      providerDiagnostic: {
        operation: 'create_post',
        outcome: zernioOutcome(error),
        requestId: sanitizedZernioDiagnostic(error?.requestId, 240),
      },
    };
  }

  return {
    state: 'failed',
    retryable: error?.retryable ?? true,
    errorCode: error?.code ?? 'zernio_request_failed',
    errorMessage: zernioErrorMessage(error),
    providerPressure: error?.httpStatus === 429
      || error?.httpStatus >= 500
      || ['timeout', 'network_error'].includes(zernioOutcome(error)),
  };
}

async function reconcileZernioCreationOutcome(item, error) {
  const existingPostId = zernioExistingPostId(error);
  const shouldReconcile = existingPostId || zernioFailureResult(error).errorCode === 'zernio_creation_outcome_unknown';
  if (!shouldReconcile || !item.profile.organization_id || !item.profile.zernio_account_id) return null;
  const telemetryContext = {
    operation: existingPostId ? 'reconcile_existing_post' : 'reconcile_creation',
    itemId: item.id,
    batchId: item.batch_id,
    correlationId: item.correlation_id,
    attemptCount: item.attempt_count,
  };
  const client = item.profile.zernio_connection_id
    ? await createZernioClientForConnection(item.profile.organization_id, item.profile.zernio_connection_id, telemetryContext)
    : await createZernioClientForOrganization(item.profile.organization_id, telemetryContext);

  let posts;
  if (existingPostId) {
    const response = await client.getPost(existingPostId);
    posts = response.post ? [response.post] : [];
  } else {
    const anchor = Number.isNaN(Date.parse(item.execute_at ?? '')) ? Date.now() : Date.parse(item.execute_at);
    const response = await client.listPosts({
      accountId: item.profile.zernio_account_id,
      source: 'zernio',
      dateFrom: new Date(anchor - 10 * 60_000).toISOString(),
      dateTo: new Date(Math.max(Date.now() + 5 * 60_000, anchor + 2 * 60 * 60_000)).toISOString(),
      limit: 100,
      sortBy: 'created-asc',
    });
    posts = response.posts ?? [];
  }

  const matches = posts.filter((post) => zernioPostMatchesWorkItem(post, item));
  if (matches.length !== 1) return null;
  const result = statusResult(matches[0]);
  return result.state === 'published'
    ? { ...result, recovered: true, creationId: zernioPostId(matches[0]) }
    : result;
}

export function zernioWorkItemRequiresManualReconciliation(item) {
  return item?.profile?.provider === 'zernio'
    && Number(item?.zernio_recovery_count ?? 0) > 0
    && !item?.creation_id;
}

function statusResult(post) {
  const platform = zernioPlatformEntry(post);
  const platformStatus = normalizedStatus(platform?.status);
  const postStatus = normalizedStatus(post.status);
  const published = ['published', 'success', 'posted', 'completed'].includes(platformStatus)
    || ['published', 'success', 'posted', 'completed'].includes(postStatus);
  if (published) return { state: 'published', metaMediaId: platform?.platformPostUrl ?? post.platformPostUrl ?? zernioPostId(post) };

  const failed = ['failed', 'error', 'rejected', 'cancelled'].includes(platformStatus)
    || ['failed', 'error', 'rejected', 'cancelled'].includes(postStatus);
  if (failed) {
    const message = platform?.failureReason
      ?? platform?.error
      ?? platform?.errorMessage
      ?? platform?.message
      ?? 'Zernio informou falha ao publicar no Instagram sem detalhar o motivo.';
    const category = typeof platform?.errorCategory === 'string' ? platform.errorCategory : null;
    const source = typeof platform?.errorSource === 'string' ? platform.errorSource : null;
    const providerCode = typeof platform?.errorCode === 'string' ? platform.errorCode : null;
    return {
      state: 'failed',
      retryable: false,
      errorCode: category ?? (platformStatus || postStatus || 'zernio_publication_failed'),
      errorMessage: `${String(message)}${source ? ` (origem: ${source})` : ''}${providerCode ? ` [código Zernio: ${providerCode}]` : ''}`.slice(0, 420),
      providerDiagnostic: {
        category,
        source,
        providerCode,
        postId: zernioPostId(post),
        platformStatus: platformStatus || null,
        postStatus: postStatus || null,
      },
    };
  }

  const id = zernioPostId(post);
  if (!id) throw publicationDataError('Zernio não retornou o identificador do post.', 'missing_zernio_post_id');
  return { state: 'processing', creationId: id };
}

function zernioClientForWorkItem(item, operation) {
  const context = {
    operation,
    itemId: item.id,
    batchId: item.batch_id,
    correlationId: item.correlation_id,
    attemptCount: item.attempt_count,
  };
  return item.profile.zernio_connection_id
    ? createZernioClientForConnection(item.profile.organization_id, item.profile.zernio_connection_id, context)
    : createZernioClientForOrganization(item.profile.organization_id, context);
}

export async function buildZernioMediaItems(item, options = {}) {
  const urls = await buildVerifiedMediaUrls(item, options);
  return item.media.map((media, index) => ({ type: media.kind, url: urls[index] }));
}

function validateZernioMedia(item) {
  if (item.format === 'image') {
    if (item.media.length !== 1) throw publicationDataError('Publicação de imagem via Zernio requer exatamente uma mídia.', 'zernio_image_media_count_invalid');
    if (item.media[0].kind !== 'image') throw publicationDataError('Publicação de imagem via Zernio requer arquivo de imagem.', 'zernio_image_media_invalid');
    return;
  }
  if (item.format === 'reel') {
    if (item.media.length !== 1) throw publicationDataError('Reel via Zernio requer exatamente um vídeo.', 'zernio_reel_media_count_invalid');
    if (item.media[0].kind !== 'video') throw publicationDataError('Reel via Zernio requer exatamente um vídeo.', 'zernio_reel_media_invalid');
    return;
  }
  if (item.format === 'story') {
    if (item.media.length !== 1) throw publicationDataError('Story via Zernio requer exatamente uma mídia.', 'zernio_story_media_count_invalid');
    if (item.media[0].kind !== 'image' && item.media[0].kind !== 'video') throw publicationDataError('Story via Zernio requer imagem ou vídeo.', 'zernio_story_media_invalid');
    return;
  }
  if (item.format === 'carousel') {
    if (item.media.length < 2 || item.media.length > 10) throw publicationDataError('Carrossel via Zernio requer entre 2 e 10 mídias.', 'zernio_carousel_media_count_invalid');
    if (item.media.some((media) => media.kind !== 'image' && media.kind !== 'video')) throw publicationDataError('Carrossel via Zernio aceita apenas imagens e vídeos.', 'zernio_carousel_media_invalid');
    return;
  }
  throw publicationDataError('Formato não suportado pela Zernio.', 'zernio_format_not_supported');
}

async function platformSpecificData(format, item) {
  if (format === 'story') return { contentType: 'story' };
  if (format === 'reel') return {
    shareToFeed: true,
      ...(item.cover
      ? { instagramThumbnail: (await buildVerifiedMediaUrls({ ...item, media: [item.cover] }))[0] }
      : {}),
  };
  return undefined;
}

async function createZernioPost(item) {
  const accountId = item.profile.zernio_account_id;
  if (!item.profile.organization_id) throw publicationDataError('Organização do perfil Zernio ausente.');
  if (!accountId) throw publicationDataError('Perfil não possui social account da Zernio.');
  validateZernioMedia(item);

  const client = item.profile.zernio_connection_id
    ? await createZernioClientForConnection(item.profile.organization_id, item.profile.zernio_connection_id, {
      operation: 'create_post', itemId: item.id, batchId: item.batch_id, correlationId: item.correlation_id, attemptCount: item.attempt_count,
    })
    : await createZernioClientForOrganization(item.profile.organization_id, {
      operation: 'create_post', itemId: item.id, batchId: item.batch_id, correlationId: item.correlation_id, attemptCount: item.attempt_count,
    });
  const stagedPayload = item.staged_provider_payload;
  const specificData = stagedPayload?.platformSpecificData ?? await platformSpecificData(item.format, item);
  const response = await client.createPost({
    content: item.caption ?? '',
    mediaItems: stagedPayload?.mediaItems ?? await buildZernioMediaItems(item),
    platforms: [{ platform: 'instagram', accountId, ...(specificData ? { platformSpecificData: specificData } : {}) }],
    publishNow: true,
  }, `athena-${item.id}${item.zernio_recovery_count > 0 ? '-recovery-1' : ''}`);

  const post = response.post ?? response.existingPost;
  const result = statusResult(post ?? {});
  if (result.state === 'processing') return result.creationId;
  if (result.state === 'published') return zernioPostId(post) ?? result.metaMediaId ?? item.id;
  if (result.state === 'failed' || result.state === 'removed') throw publicationDataError(result.errorMessage, result.errorCode);
  throw publicationDataError('A Zernio adiou a publicação de forma inesperada.', 'zernio_unexpected_deferred_state');
}

async function processZernioInstagramPublication(item, beforeProviderRequest) {
  try {
    if (beforeProviderRequest && !await beforeProviderRequest()) return suspendedWorkItem();
    if (!item.creation_id) return { state: 'processing', creationId: await createZernioPost(item) };
    if (!item.profile.organization_id) throw publicationDataError('Organização do perfil Zernio ausente.');
    const client = item.profile.zernio_connection_id
      ? await createZernioClientForConnection(item.profile.organization_id, item.profile.zernio_connection_id, {
        operation: 'get_post', itemId: item.id, batchId: item.batch_id, correlationId: item.correlation_id, attemptCount: item.attempt_count,
      })
      : await createZernioClientForOrganization(item.profile.organization_id, {
        operation: 'get_post', itemId: item.id, batchId: item.batch_id, correlationId: item.correlation_id, attemptCount: item.attempt_count,
      });
    const response = await client.getPost(item.creation_id);
    if (!response.post) throw publicationDataError('Zernio não retornou dados do post.', 'zernio_post_missing');
    const result = statusResult(response.post);
    if (result.state === 'published') {
      await Promise.all(item.media.map((media) => recordMediaDeliveryAttempt(item, media, 'provider_download', 'succeeded')));
    } else if (result.state === 'failed' && isProviderMediaDownloadFailure(result)) {
      await Promise.all(item.media.map(async (media) => recordMediaDeliveryAttempt(item, media, 'provider_download', 'failed', {
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
        urlFingerprint: await latestProviderUrlFingerprint(item, media),
      })));
    }
    return result;
  } catch (error) {
    const shouldReconcile = zernioExistingPostId(error)
      || zernioFailureResult(error).errorCode === 'zernio_creation_outcome_unknown';
    if (shouldReconcile) {
      for (const delayMs of [0, 15_000, 30_000]) {
        await wait(delayMs);
        try {
          const reconciled = await reconcileZernioCreationOutcome(item, error);
          if (reconciled) return reconciled;
        } catch (reconciliationError) {
          console.error('Consulta de reconciliação Zernio não confirmou o resultado da criação.', {
            itemId: item.id,
            delayMs,
            error: errorInfo(reconciliationError),
          });
        }
      }
    }
    const failedResult = zernioFailureResult(error);
    if (isProviderMediaDownloadFailure(failedResult)) {
      await Promise.all(item.media.map(async (media) => recordMediaDeliveryAttempt(item, media, 'provider_download', 'failed', {
        errorCode: failedResult.errorCode,
        errorMessage: failedResult.errorMessage,
        urlFingerprint: await latestProviderUrlFingerprint(item, media),
      }).catch((recordError) => console.error('Falha ao registrar download rejeitado pela Zernio.', errorInfo(recordError)))));
    }
    return failedResult;
  }
}

export async function loadWorkItem(item, options = {}) {
  const clientFactory = options.createSupabase ?? createSupabase;
  const supabase = clientFactory();
  const [profileResult, mediaResult, stateResult] = await Promise.all([
    supabase
      .from('instagram_profiles')
      .select('id, organization_id, provider, instagram_user_id, encrypted_access_token, zernio_account_id, zernio_connection_id, status')
      .eq('id', item.profile_id)
      .eq('organization_id', item.organization_id)
      .is('deleted_at', null)
      .maybeSingle(),
    supabase
      .from('publication_item_media')
      .select('position, media_assets!inner(id, storage_path, kind, status, deleted_at, organization_id)')
      .eq('publication_item_id', item.id)
      .eq('organization_id', item.organization_id)
      .order('position'),
    supabase
      .from('publication_items')
      .select('container_poll_count, provider_creation_started_at, zernio_recovery_count, zernio_recovery_poll_at, reel_cover_media_asset_id')
      .eq('id', item.id)
      .eq('organization_id', item.organization_id)
      .maybeSingle(),
  ]);

  if (profileResult.error || !profileResult.data) return invalidWorkItem('O perfil do Instagram não está mais disponível.');
  if (profileResult.data.status !== 'online') return suspendedWorkItem();
  if (mediaResult.error) return invalidWorkItem('Não foi possível carregar as mídias do item.');
  if (stateResult.error || !stateResult.data) return invalidWorkItem('Não foi possível carregar o estado de recuperação do item.');

  const mediaRows = mediaResult.data ?? [];
  const hasDeletedMedia = mediaRows.some((row) => {
    const asset = Array.isArray(row.media_assets) ? row.media_assets[0] : row.media_assets;
    return Boolean(asset && asset.organization_id === item.organization_id && (asset.deleted_at || asset.status === 'deleted'));
  });
  if (hasDeletedMedia) return removedWorkItem();

  const media = mediaRows.flatMap((row) => {
    const asset = Array.isArray(row.media_assets) ? row.media_assets[0] : row.media_assets;
    if (!asset || asset.organization_id !== item.organization_id) return [];
    if (asset.status !== 'ready') return [];
    if (asset.kind !== 'image' && asset.kind !== 'video') return [];
    return [{ id: asset.id, storage_path: asset.storage_path, kind: asset.kind }];
  });

  if (media.length !== mediaRows.length) return invalidWorkItem('Uma ou mais mídias não estão prontas para publicação.');

  let cover = null;
  if (stateResult.data.reel_cover_media_asset_id) {
    const coverResult = await supabase
      .from('media_assets')
      .select('id, storage_path, kind, status, deleted_at, organization_id')
      .eq('id', stateResult.data.reel_cover_media_asset_id)
      .eq('organization_id', item.organization_id)
      .maybeSingle();
    if (coverResult.error || !coverResult.data || coverResult.data.deleted_at || coverResult.data.status === 'deleted') {
      return removedWorkItem('A capa personalizada foi apagada.');
    }
    if (coverResult.data.status !== 'ready' || coverResult.data.kind !== 'image') {
      return invalidWorkItem('A capa personalizada não está pronta para publicação.');
    }
    if (item.format !== 'reel') return invalidWorkItem('Capa personalizada só pode ser usada em Reel.');
    cover = { id: coverResult.data.id, storage_path: coverResult.data.storage_path, kind: 'image' };
  }

  return {
    id: item.id,
    batch_id: item.batch_id,
    attempt_count: item.attempt_count,
    correlation_id: item.correlation_id ?? null,
    format: item.format,
    caption: item.caption,
    creation_id: item.creation_id,
    container_poll_count: stateResult.data.container_poll_count ?? 0,
    provider_creation_started_at: stateResult.data.provider_creation_started_at ?? null,
    zernio_recovery_count: stateResult.data.zernio_recovery_count ?? 0,
    zernio_recovery_poll_at: stateResult.data.zernio_recovery_poll_at ?? null,
    execute_at: item.execute_at ?? null,
    profile: profileResult.data,
    media,
    cover,
  };
}

// Cria o snapshot recuperável antes do horário. Nenhum token é persistido no
// spool: itens Meta são reidratados no vencimento; para Zernio ficam somente
// IDs não secretos e URLs temporárias já verificadas.
export async function preparePublicationDispatchEnvelope(item, options = {}) {
  const workItem = await loadWorkItem(item, options);
  const base = {
    itemId: item.id,
    organizationId: item.organization_id,
    profileId: item.profile_id,
    // Usado para limitar o lote a um item por perfil e formato — reel disputa
    // com reel, story não interfere.
    format: item.format ?? null,
    executeAt: item.execute_at,
  };
  if ('state' in workItem) return { ...base, workItem };
  if (workItem.profile.provider !== 'zernio') {
    return { ...base, requiresReload: true, workItem: { id: item.id } };
  }
  validateZernioMedia(workItem);
  const mediaItems = await buildZernioMediaItems(workItem, options);
  const specificData = await platformSpecificData(workItem.format, workItem);
  return {
    ...base,
    requiresReload: false,
    workItem: {
      ...workItem,
      profile: { ...workItem.profile, encrypted_access_token: undefined },
      staged_provider_payload: {
        mediaItems,
        ...(specificData ? { platformSpecificData: specificData } : {}),
      },
    },
  };
}

// A preparação v2 valida somente dados locais. Ela não lê nem transfere os
// bytes da mídia, não cria post e não chama Zernio ou Meta.
export function validatePreparedPublicationWorkItem(workItem) {
  if (!workItem || typeof workItem !== 'object') {
    throw publicationDataError('Item ausente durante a preparação local.', 'preparation_item_missing');
  }
  if ('state' in workItem) {
    throw publicationDataError(
      workItem.errorMessage ?? 'Item bloqueado durante a preparação local.',
      workItem.errorCode ?? 'preparation_blocked',
    );
  }
  if (!workItem.profile?.organization_id) {
    throw publicationDataError('Organização do perfil ausente.', 'preparation_profile_organization_missing');
  }
  if (workItem.profile.provider === 'zernio') {
    if (!workItem.profile.zernio_account_id) {
      throw publicationDataError('Perfil sem social account da Zernio.', 'preparation_zernio_account_missing');
    }
    validateZernioMedia(workItem);
    return { ready: true, provider: 'zernio', mediaCount: workItem.media.length };
  }
  if (workItem.profile.provider === 'meta_official') {
    if (!workItem.profile.instagram_user_id || !workItem.profile.encrypted_access_token) {
      throw publicationDataError('Perfil Meta sem identidade ou token local.', 'preparation_meta_credentials_missing');
    }
    if (workItem.format === 'carousel') {
      if (workItem.media.length < 2 || workItem.media.length > 10) {
        throw publicationDataError('Carrossel requer entre 2 e 10 mídias.', 'preparation_carousel_media_count_invalid');
      }
    } else if (workItem.media.length !== 1) {
      throw publicationDataError('O formato requer exatamente uma mídia.', 'preparation_media_count_invalid');
    }
    if (workItem.format === 'image' && workItem.media[0]?.kind !== 'image') {
      throw publicationDataError('Publicação de imagem requer uma imagem.', 'preparation_image_media_invalid');
    }
    if (workItem.format === 'reel' && workItem.media[0]?.kind !== 'video') {
      throw publicationDataError('Reel requer um vídeo.', 'preparation_reel_media_invalid');
    }
    return { ready: true, provider: 'meta_official', mediaCount: workItem.media.length };
  }
  throw publicationDataError('Provedor do perfil não suportado.', 'preparation_provider_unsupported');
}

export async function preparePublicationQueueDirect(options = {}) {
  const workerId = options.workerId?.trim().slice(0, 120) || `prepare-${randomUUID()}`;
  const limit = Number.isInteger(options.limit) ? Math.min(Math.max(options.limit, 1), 500) : 100;
  const concurrency = Number.isInteger(options.concurrency)
    ? Math.min(Math.max(options.concurrency, 1), 20)
    : 4;
  const leaseSeconds = Number.isInteger(options.leaseSeconds) ? Math.min(Math.max(options.leaseSeconds, 30), 900) : 180;
  const windowHours = Number.isInteger(options.windowHours) ? Math.min(Math.max(options.windowHours, 1), 24) : 24;
  const supabase = (options.createSupabase ?? createSupabase)();
  // O LOTE PRECISA CABER NO LEASE. Esta conta e a correcao de 07/09/2026.
  //
  // O lote era pedido pelo `limit` (150 por padrao no .env) e o lease vinha
  // fixo em 180 s, sem nenhuma relacao entre os dois. Com concorrencia 8, um
  // lote de 150 leva ~19 rodadas; se cada item gasta 10 s -- e gasta, porque
  // preparar faz REDE (assina URL, carrega midia) --, sao 190 s. Os ultimos
  // itens do lote estouram o proprio lease ANTES de terminarem, e
  // `complete_publication_preparation` os recusa com 40001.
  //
  // Por desenho, o fim de todo lote grande falhava. E piorou sozinho conforme a
  // frota cresceu, porque o lote foi ficando mais lento sem o lease mudar --
  // que e exatamente a descricao que a operacao deu: "isso rodava direitinho e
  // com espaco, alguma coisa passou a comer CPU".
  //
  // Agora o lote e limitado pelo que cabe: itens = concorrencia x (lease /
  // segundos por item), com margem de 40%. O padrao de 12 s por item vem da
  // medicao do dia; sobe se a midia ficar mais pesada.
  const segundosPorItem = integerEnv('PUBLICATION_WORKER_PREPARATION_ITEM_SECONDS', 12, 2, 120);
  const cabeNoLease = Math.max(1, Math.floor((concurrency * leaseSeconds) / segundosPorItem * 0.6));
  const loteEfetivo = Math.min(limit, cabeNoLease);
  const { data, error } = await supabase.rpc('claim_publication_preparation_items', {
    p_worker_id: workerId,
    p_limit: loteEfetivo,
    p_lease_seconds: leaseSeconds,
    p_window_hours: windowHours,
  });
  if (error) throw error;

  const claimed = data ?? [];
  const settled = await mapWithConcurrency(claimed, concurrency, async (item) => {
    try {
      const workItem = await loadWorkItem({
        ...item,
        attempt_count: 0,
        creation_id: null,
        correlation_id: options.correlationId ?? null,
      }, options);
      validatePreparedPublicationWorkItem(workItem);
      const { error: completionError } = await supabase.rpc('complete_publication_preparation', {
        p_item_id: item.id,
        p_worker_id: workerId,
        p_ready: true,
        p_error_code: null,
        p_error_message: null,
        p_retry_seconds: 900,
      });
      if (completionError) throw completionError;
      return { itemId: item.id, state: 'ready' };
    } catch (preparationError) {
      const failure = errorInfo(preparationError);
      // FALHA DE INFRAESTRUTURA NAO GERA SEGUNDA CHAMADA. Este `if` e a correcao
      // do que derrubou a API duas vezes em 07/09/2026.
      //
      // O caminho de erro daqui chamava `complete_publication_preparation` de
      // novo para registrar o motivo da falha. Faz sentido quando o motivo e do
      // ITEM -- midia sumida, formato invalido. Mas quando o motivo e "nao
      // consegui falar com o banco" (PGRST003, pool esgotado), a resposta virava
      // "falar com o banco de novo": cada item passava a custar DUAS chamadas
      // contra o recurso que ja estava no limite. Com `PREPARATION_LIMIT=150`,
      // uma rodada que falha dispara 300 chamadas em vez de 150.
      //
      // Foi o que o par mediu do outro lado: 28 das 41 vagas do pool em
      // `complete_publication_preparation`, dez delas em transacao ABORTADA, e
      // o pg_stat_statements cravado -- porque ele nao contabiliza statement que
      // termina em erro. Contador parado com conexao ocupada e a assinatura de
      // chamada que aborta em laco.
      //
      // Sem a segunda chamada o item simplesmente nao e concluido: o lease
      // expira e ele volta a ser reivindicado no proximo ciclo, que e
      // exatamente o comportamento certo para indisponibilidade passageira. O
      // principio e o mesmo da 272 -- indisponibilidade de banco nunca vira
      // estado terminal --, aplicado agora tambem ao caminho de PREPARO.
      if (isPublicationInfrastructureError(preparationError)) {
        return { itemId: item.id, state: 'infrastructure_deferred', errorCode: failure.code ?? 'infrastructure' };
      }
      // LEASE PERDIDO NAO SE REGISTRA: nao ha o que registrar.
      //
      // `complete_publication_preparation` (migration 264) recusa quando o item
      // nao esta mais sob o lease deste worker, com 40001 "Lease de preparacao
      // ausente ou expirado". Se a PRIMEIRA chamada morreu assim, a segunda vai
      // morrer igual -- o item ja foi liberado e outro processo vai pega-lo.
      //
      // MEDIDO EM 07/09/2026: o log do Postgres tinha 6.760.250 ERROS em 24
      // horas, 78 por segundo, e praticamente todos eram esta mensagem. Cada
      // item que estourava o lease gerava DUAS falhas, porque o caminho de erro
      // tentava registrar o motivo chamando de novo a funcao que acabara de
      // recusar. Escrever essa montanha de log e responder a essas chamadas
      // consumia CPU do banco sem produzir nada.
      //
      // A CAUSA DE FUNDO e o lote nao caber no lease -- ver o comentario em
      // `preparationBatchLimit`. Este `if` corta a amplificacao; o outro corta
      // a origem.
      if (String(failure.code ?? '') === '40001') {
        return { itemId: item.id, state: 'lease_lost' };
      }
      const { error: completionError } = await supabase.rpc('complete_publication_preparation', {
        p_item_id: item.id,
        p_worker_id: workerId,
        p_ready: false,
        p_error_code: failure.code ?? 'preparation_failed',
        p_error_message: failure.message ?? 'Falha na preparação local.',
        p_retry_seconds: 900,
      });
      if (completionError) throw completionError;
      return { itemId: item.id, state: 'blocked', errorCode: failure.code ?? 'preparation_failed' };
    }
  });

  const results = settled.map((entry, index) => entry.status === 'fulfilled'
    ? entry.value
    : { itemId: claimed[index].id, state: 'error', error: errorInfo(entry.reason).message });
  return {
    claimed: claimed.length,
    ready: results.filter((item) => item.state === 'ready').length,
    blocked: results.filter((item) => item.state === 'blocked').length,
    errors: results.filter((item) => item.state === 'error').length,
    results,
  };
}

// shouldStop é checado antes de cada item novo ser retirado da fila (cancelamento
// cooperativo): itens já em andamento sempre terminam, mas nenhum trabalhador pega
// um item novo depois que shouldStop() vira true. Índices nunca tentados ficam
// undefined no array de resultados, distinguíveis de 'fulfilled'/'rejected'.
export async function mapWithConcurrency(items, concurrency, mapper, shouldStop = () => false) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const workerCount = Math.min(Math.max(Number(concurrency) || 1, 1), items.length);
  const results = new Array(items.length);
  let nextIndex = 0;

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      if (shouldStop()) return;
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { status: 'fulfilled', value: await mapper(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }));

  return results;
}

// MEDIDO EM 07/09/2026. O custo de encerrar e de ~54 ms POR ITEM, linear:
//
//   p_limit= 10 ->   778 ms
//   p_limit= 50 -> 2.724 ms
//   p_limit=150 -> 57014 (estoura os 8 s do statement_timeout, em ~148 itens)
//
// Com `p_limit: 500` a varredura falhava INTEIRA sempre que havia fila de
// verdade -- e falhava em silencio, porque o erro so vira um console.error e o
// ciclo segue. Resultado observado: 235 itens elegiveis para o corte que
// ninguem encerrava, alguns ha 12 minutos. Ou seja, a regra de "nao publicar
// atrasado" parava de valer exatamente quando ela era necessaria.
//
// 60 por chamada da ~3,2 s, com folga confortavel para os 8 s. A vazao continua
// sobrando: o ciclo roda a cada ~20 s, entao sao ~180/min contra um pico
// observado de 211 descartes por HORA. Preferir muitas passadas pequenas a uma
// grande e a licao da Armadilha nº 4 do mapa: o lote grande nao e mais
// eficiente, e so mais fragil.
const EXPIRACAO_POR_CHAMADA = integerEnv('PUBLICATION_WORKER_EXPIRE_LIMIT', 60, 10, 400);

async function expireLatePublicationItems() {
  const supabase = createSupabase();
  const { data, error } = await supabase.rpc('expire_late_publication_items', { p_limit: EXPIRACAO_POR_CHAMADA });
  // Encerrar atrasado e higiene, nao o trabalho do ciclo: se falhar, o despacho
  // continua. O claim ja recusa esses itens de qualquer forma.
  if (error) {
    console.error('[publication-worker] falha ao encerrar atrasados', { message: error.message });
    return { expired: 0 };
  }
  return data ?? { expired: 0 };
}

/**
 * Recalcula o resumo materializado da fila (migration 418).
 *
 * Roda AQUI, e nao so no cron da Vercel, pelo mesmo motivo escrito no commit
 * f23d99e: rotina que existe so no painel fica parada quando o painel nao e
 * implantado. Quem paga o custo e este ciclo, fora do caminho da tela -- a
 * leitura da /queue caiu de 8.941 ms para 125 ms por causa disso.
 *
 * O intervalo minimo evita recalcular a cada ciclo do worker, que e bem mais
 * rapido que um minuto: o recalculo custa ~17 s por organizacao grande, e a
 * tela consulta no maximo 1x/min.
 */
const QUEUE_SUMMARY_MIN_INTERVAL_MS = 60_000;
// DESLIGADO POR PADRAO desde 07/09/2026, e o motivo e de arquitetura.
//
// O dono deste recalculo e o cron da Vercel, que ja roda
// `/api/internal/queue-summary-refresh` a cada minuto (vercel.json). A copia
// aqui nasceu como rede de seguranca -- "rotina que so existe no painel fica
// parada quando o painel nao e implantado" -- e a preocupacao e legitima, mas o
// lugar estava errado, por tres razoes medidas:
//
//   CUSTO. Medido em 07/09: 28,9 s para a Pomodoro (541.417 itens) e 6,5 s para
//   a Vini (530.270). ~36 s por passada, dentro do laco que publica.
//
//   ACOPLAMENTO EM REALIMENTACAO. O custo e O(tamanho da fila). A fila cresce
//   justamente quando a publicacao esta atrasada. Ou seja: quanto pior a
//   situacao, mais caro fica o resumo e mais tempo ele rouba de quem deveria
//   estar resolvendo a situacao. Componente que fica mais caro conforme o
//   hospedeiro piora e a pior forma de acoplamento que existe.
//
//   MULTIPLICACAO. Em 07/09 o publicador passou de 1 para 4 processos. Como o
//   recalculo mora no codigo compartilhado, ele passou a rodar 4 vezes -- 5 com
//   o cron da Vercel -- agregando o mesmo milhao de linhas.
//
// A rede de seguranca continua disponivel: PUBLICATION_WORKER_QUEUE_SUMMARY=true
// religa, e deve ser ligada em UM processo so. O lugar certo em definitivo e um
// worker proprio, como ja existe para media-maintenance e profile-analytics.
const queueSummaryEnabled = (process.env.PUBLICATION_WORKER_QUEUE_SUMMARY || 'false') === 'true';
let ultimoResumoDaFilaEm = 0;

async function refreshQueueSummaries() {
  if (Date.now() - ultimoResumoDaFilaEm < QUEUE_SUMMARY_MIN_INTERVAL_MS) return { skipped: true };
  ultimoResumoDaFilaEm = Date.now();
  const supabase = createSupabase();
  const { data: organizations, error: organizationsError } = await supabase
    .from('organizations')
    .select('id')
    .order('id', { ascending: true });
  if (organizationsError) {
    console.error('[publication-worker] falha ao listar organizacoes para o resumo', { message: organizationsError.message });
    return { refreshed: 0 };
  }
  let refreshed = 0;
  for (const organization of organizations ?? []) {
    const { error } = await supabase.rpc('refresh_publication_queue_summary', {
      p_organization_id: organization.id,
      p_history_hours: 24,
    });
    // Resumo e leitura, nao publicacao: falhar aqui nao pode parar o ciclo.
    if (error) {
      console.error('[publication-worker] falha ao recalcular resumo da fila', { organizationId: organization.id, message: error.message });
      continue;
    }
    refreshed += 1;
  }
  return { refreshed };
}

/**
 * Alarme da fila de CONFIRMACAO.
 *
 * POR QUE EXISTE. Em 06/09/2026 dois itens presos estrangularam a perna de
 * confirmacao por horas, e nada gritou. O sinal de pressao existia e estava
 * ligado -- mas ligado o dia inteiro, por item ja aceito aguardando
 * confirmacao, que e situacao normal. Um alarme verdadeiro 99% do tempo nao
 * informa nada (secao 3 do mapa de controles). Ninguem viu ate o usuario
 * perguntar por que a postagem demorava 30 minutos, e ai ja eram 723 posts
 * perdidos.
 *
 * O QUE ELE MEDE, e por que este numero e diferente. Nao e "existe item
 * vencido" -- isso e verdade quase sempre. E "existe item com o conteiner JA
 * CRIADO na Meta, cujo `next_attempt_at` JA PASSOU, e que mesmo assim continua
 * parado". Esse item nao espera a Meta e nao espera o horario: espera VAGA. Em
 * regime saudavel esse numero fica em dezenas, porque o ciclo o consome em
 * seguida. Durante o incidente ele passou de 900.
 *
 * Sai em `console.error` de proposito, porque o log de erro do PM2 e o sinal
 * que a operacao olha. E so quando cruza o limiar -- ruido aqui destruiria o
 * valor do proprio canal.
 */
const CONFIRMACAO_LIMIAR = integerEnv('PUBLICATION_WORKER_CONFIRMATION_ALERT', 300, 20, 100_000);
const CONFIRMACAO_INTERVALO_MS = 60_000;
let ultimaChecagemDeConfirmacao = 0;
let confirmacaoJaAlarmada = false;

async function checarFilaDeConfirmacao() {
  if (Date.now() - ultimaChecagemDeConfirmacao < CONFIRMACAO_INTERVALO_MS) return null;
  ultimaChecagemDeConfirmacao = Date.now();
  const supabase = createSupabase();
  const { count, error } = await supabase
    .from('publication_items')
    .select('id', { count: 'exact', head: true })
    .not('creation_id', 'is', null)
    .eq('status', 'waiting')
    .lte('next_attempt_at', new Date().toISOString());
  // Falhar aqui e um alarme quebrado, nao uma fila quebrada: nao para o ciclo.
  if (error) return null;
  const represado = count ?? 0;
  if (represado >= CONFIRMACAO_LIMIAR && !confirmacaoJaAlarmada) {
    confirmacaoJaAlarmada = true;
    console.error('[publication-worker] FILA DE CONFIRMACAO REPRESADA', {
      itensElegiveisParados: represado,
      limiar: CONFIRMACAO_LIMIAR,
      significado: 'itens com conteiner criado na Meta cujo horario de consulta ja passou e que continuam sem ser reivindicados',
      ondeOlhar: 'limiteAdaptativo no ciclo DIRETO; se estiver preso em 1-3, ver secao 3-C do mapa de controles',
    });
  }
  // So volta a poder alarmar depois de normalizar de verdade (metade do
  // limiar), para nao piscar em volta da fronteira.
  if (confirmacaoJaAlarmada && represado < CONFIRMACAO_LIMIAR / 2) {
    confirmacaoJaAlarmada = false;
    console.error('[publication-worker] fila de confirmacao normalizada', { itensElegiveisParados: represado });
  }
  return represado;
}

async function recoverMissedPublicationSchedules(options = {}) {
  const supabase = createSupabase();
  const { data, error } = await supabase.rpc('recover_missed_publication_slots', {
    p_max_items: 100,
    p_grace_seconds: 120,
    p_worker_id: options.workerId ?? null,
    p_cycle_correlation_id: options.correlationId ?? null,
  });
  if (error) throw error;
  const recovered = data ?? [];
  return {
    scanned: recovered.length,
    rescheduled: recovered.filter((item) => item.outcome === 'rescheduled_once').length,
    requiresAttention: recovered.filter((item) => item.outcome === 'requires_attention').length,
    bulkSlotsAtRisk: recovered.filter((item) => item.outcome === 'bulk_slot_at_risk').length,
    overdueAlerts: recovered.filter((item) => item.outcome === 'overdue_sla_alerted').length,
  };
}

async function claimCoordinatedBulkSlotRecoveryItems(workerId, limit, leaseSeconds) {
  if (limit < 1) return [];
  const supabase = createSupabase();
  const { data, error } = await supabase.rpc('claim_publication_slot_recovery_items', {
    p_worker_id: workerId,
    p_limit: limit,
    p_lease_seconds: leaseSeconds,
  });
  if (error) throw error;
  return data ?? [];
}

async function finalizeCoordinatedBulkSlotRecoveryItems(workerId) {
  const supabase = createSupabase();
  const { data, error } = await supabase.rpc('finalize_publication_slot_recovery_incidents', {
    p_worker_id: workerId,
  });
  if (error) throw error;
  return Number(data ?? 0);
}

async function recoverUnexpectedDispatcherFailure(itemId, workerId, error) {
  const supabase = createSupabase();
  const original = errorInfo(error);
  const message = [original.message, original.details, original.hint].filter(Boolean).join(' — ').slice(0, 1200)
    || 'Falha inesperada ao processar o item.';

  if (isPublicationInfrastructureError(error)) {
    const { error: deferError } = await supabase.rpc('defer_publication_infrastructure_failure', {
      p_item_id: itemId,
      p_worker_id: workerId,
      p_error_code: original.code || 'publication_worker_cycle_failed',
      p_error_message: message,
      p_delay_seconds: 30,
    });
    if (deferError) {
      // Nunca convertemos uma indisponibilidade do banco em falha terminal. Se
      // ate o defer falhar, o lease expira e o mesmo item volta para reconciliacao.
      console.error('Não foi possível persistir o retry de infraestrutura; o lease será recuperado.', {
        itemId,
        original,
        deferError: errorInfo(deferError),
      });
    }
    return { message, state: 'infrastructure_retry' };
  }

  const { error: completionError } = await supabase.rpc('complete_publication_item', {
    p_item_id: itemId,
    p_worker_id: workerId,
    p_outcome: 'failed',
    p_error_code: original.code || 'dispatcher_unexpected_error',
    p_error_message: message,
    p_retryable: false,
  });

  if (completionError) {
    const fallbackUpdate = await supabase
      .from('publication_items')
      .update({
        status: 'failed',
        claimed_by: null,
        lease_until: null,
        next_attempt_at: null,
        last_error_code: original.code || 'dispatcher_unexpected_error',
        last_error_message: message,
      })
      .eq('id', itemId)
      .eq('claimed_by', workerId);

    console.error('Não foi possível concluir pelo RPC; fallback direto do item executado.', {
      itemId,
      original,
      completionError: errorInfo(completionError),
      fallbackUpdateError: fallbackUpdate.error ? errorInfo(fallbackUpdate.error) : undefined,
    });
  }

  return { message, state: 'error' };
}

async function reconcilePublicationBatchRuntime(limit = 100) {
  const supabase = createSupabase();
  const { data, error } = await supabase.rpc('reconcile_publication_batch_runtime', { p_limit: limit });
  if (error) throw error;
  return data ?? { reconciledBatches: 0, newlyPausedBatches: 0, reconciledOutcomes: 0 };
}

async function suspendClaimedPublication(item, workerId, reason) {
  const supabase = createSupabase();
  const { data, error } = await supabase.rpc('suspend_claimed_publication_item', {
    p_item_id: item.id,
    p_worker_id: workerId,
    p_reason: reason,
  });
  if (error) throw error;
  return data;
}

export async function claimedProfileRemainsOnline(item, workerId, options = {}) {
  const supabase = (options.createSupabase ?? createSupabase)();
  const { data, error } = await supabase.rpc('assert_claimed_publication_profile_online', {
    p_item_id: item.id,
    p_worker_id: workerId,
  });
  if (error) throw error;
  return data === true;
}

export async function ensureClaimedProfileOnlineOrSuspend(item, workerId, options = {}) {
  const remainsOnline = options.claimedProfileRemainsOnline ?? claimedProfileRemainsOnline;
  const suspend = options.suspendClaimedPublication ?? suspendClaimedPublication;
  if (await remainsOnline(item, workerId, options)) return true;
  await suspend(item, workerId, 'Perfil offline; retomada manual necessária.');
  return false;
}

export async function preserveConfirmedPublication(itemId, workerId, metaMediaId, options = {}) {
  const supabase = (options.createSupabase ?? createSupabase)();
  const { data, error } = await supabase.rpc('reconcile_confirmed_publication_item', {
    p_item_id: itemId,
    p_worker_id: workerId,
    p_meta_media_id: metaMediaId,
  });
  if (error || !data) throw error ?? new Error('O item não pôde ser reconciliado após confirmação do provedor.');
  return data;
}

export async function preserveReconciledZernioPublication(itemId, workerId, creationId, metaMediaId, options = {}) {
  const supabase = (options.createSupabase ?? createSupabase)();
  const { data, error } = await supabase.rpc('reconcile_zernio_publication_item', {
    p_item_id: itemId,
    p_worker_id: workerId,
    p_creation_id: creationId,
    p_meta_media_id: metaMediaId ?? null,
  });
  if (error || !data) throw error ?? new Error('O item não pôde ser reconciliado com a confirmação da Zernio.');
  return data;
}

export async function preserveAcceptedProviderCreation(itemId, workerId, creationId, options = {}) {
  const supabase = (options.createSupabase ?? createSupabase)();
  const { data, error } = await supabase.rpc('reconcile_suspended_publication_creation', {
    p_item_id: itemId,
    p_worker_id: workerId,
    p_creation_id: creationId,
  });
  if (error || !data) throw error ?? new Error('A criação aceita pelo provedor não pôde ser preservada.');
  return data;
}

export async function scheduleZernioMediaDownloadRecovery(workItem, workerId, result, options = {}) {
  const supabase = (options.createSupabase ?? createSupabase)();
  const fingerprintForMedia = options.latestProviderUrlFingerprint ?? latestProviderUrlFingerprint;
  const media = Array.isArray(workItem.media) ? workItem.media : [];
  const fingerprints = await Promise.all(media.map((asset) => fingerprintForMedia(workItem, asset)));
  const { data, error } = await supabase.rpc('schedule_zernio_media_download_recovery', {
    p_item_id: workItem.id,
    p_worker_id: workerId,
    p_creation_id: workItem.creation_id,
    p_error_code: result.errorCode ?? 'zernio_media_download_failed',
    p_error_message: result.errorMessage ?? 'Instagram não conseguiu baixar a mídia pela URL entregue ao provedor.',
    p_url_fingerprint: fingerprints.find(Boolean) ?? null,
  });
  if (error) throw error;
  return data?.scheduled === true;
}

export async function retryZernioMediaDownloadOnSamePost(workItem, workerId, failure, options = {}) {
  const supabase = (options.createSupabase ?? createSupabase)();
  const { data: reservation, error: reservationError } = await supabase.rpc('reserve_zernio_same_post_media_retry', {
    p_item_id: workItem.id,
    p_worker_id: workerId,
    p_creation_id: workItem.creation_id,
    p_error_code: failure.errorCode ?? 'zernio_media_download_failed',
    p_error_message: failure.errorMessage ?? 'Instagram não conseguiu baixar a mídia entregue ao provedor.',
    p_window_seconds: options.retryWindowSeconds ?? zernioMediaRetryWindowSeconds,
  });
  if (reservationError) throw reservationError;
  if (reservation?.reserved !== true) return { started: false, reason: reservation?.reason ?? 'not_reserved' };

  try {
    const mediaItems = await buildZernioMediaItems(workItem, {
      ...options,
      forceRefresh: true,
      workerId: `${workerId}:retry`.slice(0, 120),
    });
    const client = options.client ?? await zernioClientForWorkItem(workItem, 'retry_same_post');
    await client.updatePost(workItem.creation_id, { mediaItems });
    const response = await client.retryPost(workItem.creation_id);
    const post = response?.post ?? response?.data?.post ?? null;
    const result = post ? statusResult(post) : { state: 'processing', creationId: workItem.creation_id };
    return { started: true, result: { ...result, creationId: workItem.creation_id } };
  } catch (error) {
    return {
      started: true,
      result: {
        ...zernioFailureResult(error),
        retryable: false,
        errorCode: error.code ?? 'zernio_same_post_media_retry_failed',
        errorMessage: `A recuperação no mesmo post da Zernio falhou: ${error.message ?? 'erro desconhecido'}`.slice(0, 1200),
      },
    };
  }
}

export async function deferFirstZernioMediaDownloadFailure(workItem, workerId, options = {}) {
  const supabase = (options.createSupabase ?? createSupabase)();
  const { data, error } = await supabase.rpc('defer_publication_item', {
    p_item_id: workItem.id,
    p_worker_id: workerId,
    p_creation_id: workItem.creation_id,
    p_delay_seconds: zernioPollingDelaySeconds(workItem),
    p_is_poll: true,
  });
  if (error) throw error;
  return data;
}

async function scheduleZernioProfileDisconnection(workItem, workerId, result) {
  const supabase = createSupabase();
  const { data, error } = await supabase.rpc('schedule_zernio_profile_disconnection', {
    p_item_id: workItem.id,
    p_worker_id: workerId,
    p_signal: zernioDisconnectionSignal(result),
    p_error_code: result.errorCode ?? 'zernio_account_disconnected',
    p_error_message: result.errorMessage ?? 'A Zernio informou que a conta foi desconectada.',
    // O claim que apenas identificou a queda não pode consumir uma tentativa de publicação.
    p_revert_claim_attempt: true,
  });
  if (error) throw error;
  return data;
}

// O bloqueio de API e do APP, nao deste item. A funcao abre uma janela de uma
// hora e marca como `ignored` tudo daquele app que vence nela -- nunca
// `failed`, para o disjuntor nao contar e nenhum lote pausar.
async function flagMetaAppApiBlocked(workItem, workerId, result) {
  const supabase = createSupabase();
  const { data, error } = await supabase.rpc('flag_meta_app_api_blocked', {
    p_item_id: workItem.id,
    p_worker_id: workerId,
    p_error_code: result.errorCode ?? '200',
    p_error_message: result.errorMessage ?? 'API access blocked.',
  });
  if (error) throw error;
  return data;
}

async function finalizeMetaProfileDisconnection(workItem, workerId, result) {
  const supabase = createSupabase();
  const { data, error } = await supabase.rpc('finalize_meta_profile_disconnection', {
    p_item_id: workItem.id,
    p_worker_id: workerId,
    p_error_code: result.errorCode ?? '190',
    p_error_message: result.errorMessage ?? 'Token Meta inválido; perfil removido automaticamente.',
    p_error_subcode: Number.isInteger(result.providerDiagnostic?.errorSubcode)
      ? result.providerDiagnostic.errorSubcode
      : null,
  });
  if (error) throw error;
  return data;
}

export async function processZernioProfileRecyclingJobs(workerId, limit = 10) {
  const supabase = createSupabase();
  const { data: claimed, error: claimError } = await supabase.rpc('claim_zernio_profile_recycling_jobs', {
    p_worker_id: workerId,
    p_limit: limit,
    p_lease_seconds: 180,
  });
  if (claimError) throw claimError;

  const jobs = claimed ?? [];
  const processed = await Promise.allSettled(jobs.map(async (job) => {
    let outcome = 'remote_deleted';
    let httpStatus = null;
    let requestId = null;
    let errorCode = null;
    let errorMessage = null;
    try {
      const client = job.zernio_connection_id
        ? await createZernioClientForConnection(job.organization_id, job.zernio_connection_id, { operation: 'disconnect_account' })
        : await createZernioClientForOrganization(job.organization_id, { operation: 'disconnect_account' });
      const generatedRequestId = `athena-recycle-${job.incident_id}`;
      await client.disconnectAccount(job.zernio_account_id, generatedRequestId);
      requestId = generatedRequestId;
    } catch (error) {
      const details = errorInfo(error);
      httpStatus = Number.isInteger(error?.httpStatus) ? error.httpStatus : null;
      requestId = error?.requestId ?? null;
      errorCode = details.code ?? 'zernio_account_removal_failed';
      errorMessage = zernioErrorMessage(error);
      outcome = httpStatus === 404
        ? 'already_disconnected_404'
        : error?.retryable === false
          ? 'terminal_error'
          : 'retryable_error';
    }
    const { data, error } = await supabase.rpc('complete_zernio_profile_recycling', {
      p_job_id: job.job_id,
      p_worker_id: workerId,
      p_remote_outcome: outcome,
      p_http_status: httpStatus,
      p_request_id: requestId,
      p_error_code: errorCode,
      p_error_message: errorMessage,
    });
    if (error) throw error;

    // 401 = a chave da conexao nao autoriza mais. O DELETE remoto e impossivel
    // por construcao, e repetir nao muda nada — por isso ele ja veio parar em
    // dead_letter aqui em cima. Sem este passo o perfil ficaria preso para
    // sempre: claim_zernio_profile_recycling_jobs nao reivindica dead_letter, e
    // a tela mostraria "tentar novamente" para algo que nunca vai passar.
    //
    // O encerramento e apenas do lado do Athena e diz isso em voz alta:
    // remote_result grava closed_without_remote_removal, o 401 e a mensagem
    // originais ficam no incidente, e o evento registra que a vaga remota pode
    // continuar ocupada. Ver migration 366.
    if (httpStatus === 401 && data?.deadLettered) {
      const { data: closed, error: closeError } = await supabase.rpc('finalize_zernio_removal_without_remote', {
        p_organization_id: job.organization_id,
        p_incident_id: job.incident_id,
        p_reason: `Chave Zernio sem autorização (401): a conta remota não pôde ser removida e o perfil foi encerrado apenas no Athena. ${errorMessage ?? ''}`.trim(),
      });
      if (closeError) {
        // Nao derruba o ciclo: o incidente segue em dead_letter, com a evidencia
        // intacta, e a proxima passagem tenta de novo.
        console.error('[publication-worker] falha ao encerrar localmente perfil com chave Zernio 401', {
          incidentId: job.incident_id, code: closeError.code, message: closeError.message,
        });
      } else if (closed?.closed) {
        return { jobId: job.job_id, outcome: 'closed_without_remote_removal', result: closed };
      }
    }

    return { jobId: job.job_id, outcome, result: data };
  }));
  const results = processed.map((entry, index) => entry.status === 'fulfilled'
    ? entry.value
    : { jobId: jobs[index].job_id, outcome: 'error', error: errorInfo(entry.reason).message });

  // O soft-delete local nao libera a vaga sozinho: a ocupacao da chave e
  // greatest(remote_instagram_account_count, perfis locais) e o valor remoto so
  // muda quando alguem re-lista /v1/accounts. Sem este passo a vaga so reaparece
  // no proximo "Sincronizar" manual.
  //
  // A contagem nao e decrementada: ela vem da propria Zernio na releitura. Isso
  // e o que da a certeza de que a conta saiu, e torna o passo idempotente — uma
  // releitura a mais nunca escreve um numero errado. Uma chamada por conexao,
  // nao por job.
  const removedByConnection = new Map();
  jobs.forEach((job, index) => {
    if (!job.zernio_connection_id) return;
    if (!['remote_deleted', 'already_disconnected_404'].includes(results[index]?.outcome)) return;
    const key = `${job.organization_id}:${job.zernio_connection_id}`;
    const removed = removedByConnection.get(key) ?? new Set();
    if (job.zernio_account_id) removed.add(String(job.zernio_account_id).trim());
    removedByConnection.set(key, removed);
  });
  for (const [key, removedAccountIds] of removedByConnection) {
    const separator = key.indexOf(':');
    await refreshZernioRemoteInventoryCount(
      key.slice(0, separator),
      key.slice(separator + 1),
      removedAccountIds,
    );
  }

  return results;
}

// Espelha lib/integrations/zernio-accounts.ts:refreshZernioRemoteInventorySnapshot,
// com a confirmacao pos-DELETE que os scripts de remocao ja praticam: a mesma
// listagem que produz a contagem tambem prova que a conta sumiu.
//
// A remocao remota ja aconteceu quando isto roda, entao uma falha aqui nao pode
// invalidar o job: o portao de frescor de 30 minutos faz o valor velho expirar
// e o proximo ciclo tenta de novo.
async function refreshZernioRemoteInventoryCount(organizationId, connectionId, removedAccountIds = new Set()) {
  const supabase = createSupabase();
  try {
    const client = await createZernioClientForConnection(organizationId, connectionId, { operation: 'list_accounts' });
    const response = await client.listAccounts();
    const accounts = response?.accounts ?? [];
    const count = accounts.filter((account) => account.platform === 'instagram').length;

    // Contradicao: a Zernio confirmou a remocao e continua listando a conta. Nao
    // ha o que corrigir daqui — a contagem lida continua sendo a verdade —, mas
    // o caso precisa ficar visivel em vez de virar uma vaga fantasma.
    const remoteIds = new Set(accounts
      .map((account) => account.accountId ?? account._id ?? account.id)
      .filter(Boolean)
      .map((value) => String(value).trim()));
    const stillPresent = [...removedAccountIds].filter((accountId) => remoteIds.has(accountId));
    if (stillPresent.length) {
      console.error('Conta removida na Zernio continua aparecendo no inventario da chave.', {
        organizationId,
        connectionId,
        stillPresent,
      });
    }

    const { error } = await supabase
      .from('zernio_connections')
      .update({
        remote_instagram_account_count: count,
        remote_inventory_checked_at: new Date().toISOString(),
        remote_inventory_error_code: null,
        remote_inventory_error_message: null,
      })
      .eq('id', connectionId)
      .eq('organization_id', organizationId);
    if (error) throw error;
    console.info('Inventario Zernio atualizado apos reciclagem.', {
      organizationId,
      connectionId,
      remoteInstagramAccountCount: count,
      confirmedRemovals: removedAccountIds.size - stillPresent.length,
    });
    return count;
  } catch (error) {
    console.error('Nao foi possivel atualizar o inventario Zernio apos a reciclagem.', {
      organizationId,
      connectionId,
      error: errorInfo(error),
    });
    return null;
  }
}

export function zernioPollingDelaySeconds(workItem, now = Date.now()) {
  if (!workItem.creation_id) {
    if (workItem.zernio_recovery_count === 0) return 60;
    const replacementPollAt = Date.parse(workItem.zernio_recovery_poll_at ?? '');
    if (!Number.isNaN(replacementPollAt)) return Math.max(15, Math.min(900, Math.round((replacementPollAt - now) / 1000)));
    return 180;
  }
  if (workItem.zernio_recovery_count > 0) {
    const replacementPollAt = Date.parse(workItem.zernio_recovery_poll_at ?? '');
    if (!Number.isNaN(replacementPollAt)) return Math.max(15, Math.min(900, Math.round((replacementPollAt - now) / 1000)));
    return 180;
  }
  if (workItem.container_poll_count === 0) return 120;
  if (workItem.container_poll_count === 1) {
    const startedAt = Date.parse(workItem.provider_creation_started_at ?? '');
    if (!Number.isNaN(startedAt)) return Math.max(15, Math.min(900, Math.round((startedAt + 10 * 60_000 - now) / 1000)));
  }
  return 60;
}

function zernioProcessingDeadlineFailure(workItem, result) {
  if (!workItem.creation_id) return null;
  if (workItem.zernio_recovery_count > 0) {
    return {
      state: 'failed',
      retryable: false,
      errorCode: 'zernio_recovery_confirmation_timeout',
      errorMessage: 'A criação substituta da Zernio não confirmou a publicação até a consulta final de recuperação.',
      providerDiagnostic: result.providerDiagnostic,
    };
  }
  if (workItem.container_poll_count >= 2) {
    return {
      state: 'failed',
      retryable: false,
      errorCode: 'zernio_processing_timeout',
      errorMessage: 'A Zernio não confirmou a publicação até a consulta final de 10 minutos.',
      providerDiagnostic: result.providerDiagnostic,
    };
  }
  return null;
}

async function releasePublicationDispatchCapacity(itemId) {
  const supabase = createSupabase();
  const { error } = await supabase
    .from('publication_dispatch_rate_reservations')
    .delete()
    .eq('publication_item_id', itemId);
  if (error) console.error('Não foi possível liberar reserva de capacidade de publicação.', { itemId, error: errorInfo(error) });
}

async function reservePublicationDispatchCapacity(item, workerId, reservationSeconds = 300) {
  const supabase = createSupabase();
  const { data, error } = await supabase.rpc('reserve_publication_dispatch_capacity', {
    p_item_id: item.id,
    p_worker_id: workerId,
    p_reservation_seconds: reservationSeconds,
  });
  if (error) throw error;
  const result = data?.[0];
  if (!result) throw new Error('A reserva de capacidade de publicação não retornou resultado.');
  if (!result.allowed) console.info('Publicação adiada por rate limit/fairness.', {
    itemId: item.id,
    provider: result.provider,
    reason: result.reason,
    currentCount: result.current_count,
    limitValue: result.limit_value,
    nextAttemptAt: result.next_attempt_at,
  });
  return result.allowed;
}

async function reserveDailyPublicationLimit(itemId, workerId) {
  const supabase = createSupabase();
  const { data, error } = await supabase.rpc('reserve_publication_daily_limit', {
    p_item_id: itemId,
    p_worker_id: workerId,
    p_limit: 100,
    p_reservation_seconds: 300,
  });
  if (error) throw error;
  const result = data?.[0];
  if (!result) throw new Error('A reserva do limite diário não retornou resultado.');
  if (!result.allowed) console.info('Publicação adiada pelo limite diário do perfil.', {
    itemId,
    publishedCount: result.published_count,
    nextAttemptAt: result.next_attempt_at,
  });
  return result.allowed;
}

export async function processClaimedItem(item, workerId, options = {}) {
  const fasesMs = {};
  const resultado = await comFasesDoItem(fasesMs, () => processClaimedItemComLivro(item, workerId, options));
  return { ...resultado, fasesMs };
}

async function processClaimedItemComLivro(item, workerId, options = {}) {
  const supabase = createSupabase();
  let capacityReserved = false;
  try {
    const stagedWorkItem = options.workItem && options.requiresReload !== true
      ? options.workItem
      : null;
    const workItem = stagedWorkItem
      ? {
        ...stagedWorkItem,
        id: item.id,
        batch_id: item.batch_id,
        attempt_count: item.attempt_count,
        correlation_id: item.correlation_id ?? stagedWorkItem.correlation_id ?? null,
        creation_id: item.creation_id,
        execute_at: item.execute_at ?? stagedWorkItem.execute_at ?? null,
      }
      : await medirFase('carregarItem', () => loadWorkItem(item));
    if ('state' in workItem && workItem.state === 'suspended') {
      await suspendClaimedPublication(item, workerId, workItem.errorMessage);
      return { itemId: item.id, state: 'suspended' };
    }
    // O snapshot antecipado não é autorização. Esta checagem transacional é
    // repetida imediatamente antes do provedor para capturar quedas ocorridas
    // entre o staging e o horário real da publicação.
    if (!await medirFase('perfilOnline', () => ensureClaimedProfileOnlineOrSuspend(item, workerId))) {
      return { itemId: item.id, state: 'suspended' };
    }
    if (zernioWorkItemRequiresManualReconciliation(workItem)) {
      const result = {
        state: 'failed',
        retryable: false,
        errorCode: 'zernio_automatic_recreation_disabled',
        errorMessage: 'A criação original exige reconciliação manual; uma segunda postagem automática foi bloqueada.',
      };
      const { error } = await supabase.rpc('complete_publication_item', {
        p_item_id: item.id,
        p_worker_id: workerId,
        p_outcome: 'failed',
        p_error_code: result.errorCode,
        p_error_message: result.errorMessage,
        p_retryable: false,
        p_max_attempts: PUBLICATION_MAX_ATTEMPTS,
      });
      if (error) throw error;
      return { itemId: item.id, state: 'zernio_manual_reconciliation_required' };
    }
    const reserveBeforeFinalPublish = async () => {
      if (!await medirFase('perfilOnline', () => claimedProfileRemainsOnline(item, workerId))) return false;
      const fairnessAllowed = await medirFase('reservarCapacidade', () => reservePublicationDispatchCapacity(
        item,
        workerId,
        workItem.profile.provider === 'zernio' ? 60 : 300,
      ));
      if (!fairnessAllowed) return false;
      capacityReserved = true;
      if (workItem.profile.provider !== 'zernio') {
        const dailyAllowed = await medirFase('reservarCapacidade', () => reserveDailyPublicationLimit(item.id, workerId));
        if (!dailyAllowed) await medirFase('liberarCapacidade', () => releasePublicationDispatchCapacity(item.id));
        return dailyAllowed;
      }
      return true;
    };

    let result = 'state' in workItem
      ? workItem
      : workItem.profile.provider === 'zernio'
        ? await (await reserveBeforeFinalPublish()
          ? processZernioInstagramPublication(workItem, () => claimedProfileRemainsOnline(item, workerId))
          : Promise.resolve({ state: 'deferred', reason: 'dispatch_rate_limit' }))
        : await processInstagramPublication(
          workItem,
          reserveBeforeFinalPublish,
          () => medirFase('perfilOnline', () => claimedProfileRemainsOnline(item, workerId)),
        );

    if (workItem.profile?.provider === 'zernio' && result.state === 'processing') {
      result = zernioProcessingDeadlineFailure(workItem, result) ?? result;
    }

    if (result.state === 'suspended') {
      await suspendClaimedPublication(item, workerId, result.errorMessage);
      return { itemId: item.id, state: 'suspended' };
    }

    if (result.state === 'processing') {
      const { error } = await medirFase('gravarResultado', () => supabase.rpc('defer_publication_item', {
        p_item_id: item.id,
        p_worker_id: workerId,
        p_creation_id: result.creationId,
        // 30 s, e nao 60. MEDIDO EM 06/09/2026: 98,3% dos itens do Instagram
        // publicam com `container_poll_count = 0`, ou seja ficam prontos ja na
        // PRIMEIRA consulta -- o conteiner nao estava demorando, a espera e que
        // era fixa. Cada segundo aqui e segundo com o item ocupando fila e
        // adiando a vaga do proximo. O piso da funcao e 15 s; 30 mantem margem
        // e corta o custo pela metade.
        p_delay_seconds: workItem.profile.provider === 'zernio'
          ? zernioPollingDelaySeconds(workItem)
          : META_PRIMEIRA_CONSULTA_SEGUNDOS,
        p_is_poll: Boolean(item.creation_id),
      }));
      if (error) {
        try {
          await preserveAcceptedProviderCreation(item.id, workerId, result.creationId);
          return { itemId: item.id, state: 'suspended_creation_preserved' };
        } catch {
          throw error;
        }
      }
      return { itemId: item.id, state: 'processing' };
    }

    if (workItem.profile.provider === 'zernio' && result.state === 'published' && result.recovered === true) {
      await preserveReconciledZernioPublication(
        item.id,
        workerId,
        result.creationId ?? workItem.creation_id,
        result.metaMediaId,
      );
      if (capacityReserved) await releasePublicationDispatchCapacity(item.id);
      return { itemId: item.id, state: 'published', recovered: true };
    }

    if (workItem.profile.provider === 'zernio'
      && result.state === 'failed'
      && isZernioTerminalAccountDisconnection(result)) {
      await scheduleZernioProfileDisconnection(workItem, workerId, result);
      if (capacityReserved) await releasePublicationDispatchCapacity(item.id);
      return { itemId: item.id, state: 'zernio_profile_recycling_scheduled' };
    }

    if (workItem.profile.provider === 'meta_official'
      && result.state === 'failed'
      && isMetaAppApiBlocked(result)) {
      const block = await flagMetaAppApiBlocked(workItem, workerId, result);
      if (capacityReserved) await releasePublicationDispatchCapacity(item.id);
      return { itemId: item.id, state: 'meta_app_api_blocked', block };
    }

    if (workItem.profile.provider === 'meta_official'
      && result.state === 'failed'
      && isMetaTerminalProfileDisconnection(result)) {
      const disconnection = await finalizeMetaProfileDisconnection(workItem, workerId, result);
      if (capacityReserved) await releasePublicationDispatchCapacity(item.id);
      return { itemId: item.id, state: 'meta_profile_removed', disconnection };
    }

    if (workItem.profile.provider === 'zernio'
      && result.state === 'failed'
      && item.creation_id
      && isProviderMediaDownloadFailure(result)
      && workItem.zernio_recovery_count === 0) {
      if (workItem.container_poll_count === 0) {
        await deferFirstZernioMediaDownloadFailure(workItem, workerId);
        if (capacityReserved) await releasePublicationDispatchCapacity(item.id);
        return { itemId: item.id, state: 'zernio_media_download_second_poll_scheduled' };
      }
      const recovery = await retryZernioMediaDownloadOnSamePost(workItem, workerId, result);
      if (recovery.started && recovery.result?.state === 'processing') {
        const { error: deferError } = await supabase.rpc('defer_publication_item', {
          p_item_id: item.id,
          p_worker_id: workerId,
          p_creation_id: workItem.creation_id,
          p_delay_seconds: 60,
          p_is_poll: true,
        });
        if (deferError) throw deferError;
        if (capacityReserved) await releasePublicationDispatchCapacity(item.id);
        return { itemId: item.id, state: 'zernio_same_post_media_retry_requested' };
      }
      if (recovery.started && recovery.result) result = recovery.result;
      // Sem reserva (fora da janela ou já consumida), preserva a falha original.
      // Nunca limpa creation_id e nunca cria uma segunda postagem externa.
    }

    if (result.state === 'deferred') return { itemId: item.id, state: result.reason };

    const { error } = await medirFase('gravarResultado', () => supabase.rpc('complete_publication_item', {
      p_item_id: item.id,
      p_worker_id: workerId,
      p_outcome: result.state === 'published' ? 'published' : result.state === 'removed' ? 'removed' : 'failed',
      p_meta_media_id: result.state === 'published' ? result.metaMediaId : null,
      p_error_code: result.state === 'failed' || result.state === 'removed' ? result.errorCode : null,
      p_error_message: result.state === 'failed' || result.state === 'removed' ? result.errorMessage : null,
      p_retryable: result.state === 'failed' && result.retryable,
      p_max_attempts: PUBLICATION_MAX_ATTEMPTS,
    }));
    if (error) {
      if (result.state === 'published') await preserveConfirmedPublication(item.id, workerId, result.metaMediaId);
      else throw error;
    }
    if (capacityReserved) await medirFase('liberarCapacidade', () => releasePublicationDispatchCapacity(item.id));

    return {
      itemId: item.id,
      state: result.state,
      recovered: result.state === 'published' && result.recovered === true,
      ...(result.state === 'failed' || result.state === 'removed'
        ? { errorCode: result.errorCode ?? null, providerPressure: result.providerPressure === true }
        : {}),
    };
  } catch (error) {
    if (capacityReserved) await releasePublicationDispatchCapacity(item.id);
    const recovery = await recoverUnexpectedDispatcherFailure(item.id, workerId, error);
    console.error('Falha isolada no dispatcher direto de publicação.', { itemId: item.id, error: errorInfo(error), recovery });
    return { itemId: item.id, state: recovery.state, error: recovery.message };
  }
}

// PROVA MEDIDA (30/08/2026) de que a versao anterior se auto-estrangulava.
//
// A regra era: +20% quando o lote enche, METADE quando UM UNICO item do lote da
// timeout ou erro de rede. Com a taxa de erro real da Zernio medida em ~1%
// (30 erros de rede em 2.958 requisicoes), a chance de um lote de tamanho L ter
// pelo menos um erro e 1-(0,99)^L. O equilibrio onde o crescimento empata com as
// quedas sai de:
//
//   (1-P)·log(1,2) + P·log(0,5) = 0  =>  P = 20,8%
//   1-(0,99)^L = 0,208               =>  L ~= 23
//
// Ou seja: o controlador convergia para ~23 itens por ciclo E NAO PASSAVA DISSO,
// independente da capacidade da maquina, do banco ou do provedor. Bate com o
// medido em producao: `used: 30`, ciclos de 9 a 16 itens, picos de 34 e 49, e
// 64 vagas de concorrencia ociosas com espera por slot de 3ms.
//
// Tambem explica por que duas ondas do MESMO minuto renderam 41/min (447 itens)
// e 702/min (187 itens): nao era o tamanho da onda, era onde o controlador
// estava quando ela chegou.
//
// A correcao: a queda passa a responder a TAXA de pressao, nao a um evento
// isolado. Metade so quando a pressao atinge uma fracao relevante do lote; abaixo
// disso o controlador SEGURA (nao cresce, nao cai), que preserva a reacao ao
// ruido sem colapsar por causa dele. Pressao de verdade continua derrubando pela
// metade na mesma velocidade de antes.
//
// E o mesmo remedio aplicado hoje ao backpressure da Zernio, pelo mesmo motivo:
// penalidade desproporcional disparada por evento estatisticamente rotineiro.
export function nextAdaptiveDispatchLimit(currentLimit, configuredMaximum, processed = [], claimed = 0, options = {}) {
  const maximum = Math.min(Math.max(Number(configuredMaximum) || 1, 1), 100);
  const current = Math.min(Math.max(Number(currentLimit) || 1, 1), maximum);
  // Duas familias de sinal, com pesos diferentes - mesma distincao usada no
  // backpressure da Zernio:
  //
  //   EXPLICITO (429, rate limit, too many, retry-after, ou providerPressure):
  //     o provedor disse "pare". Um so ja derruba pela metade. Nao se negocia.
  //   TRANSITORIO (timeout, erro de rede): pode ser blip da nossa ponta. So
  //     derruba quando atinge fracao relevante do lote.
  //   INFRAESTRUTURA (57014, pool, fetch failed): o BANCO engasgou, nao o
  //     provedor. Encolher o lote daqui nao alivia o banco -- a carga vem do
  //     spool (concorrencia 64), da preparacao e dos outros workers -- e o
  //     caminho direto e o UNICO que faz polling. Segurar: nao cresce, nao cai.
  const infraestrutura = (item) => `${item?.state ?? ''}`.toLowerCase() === 'infrastructure_retry';
  const explicito = (item) => {
    if (infraestrutura(item)) return false;
    if (item?.providerPressure === true) return true;
    const signal = `${item?.state ?? ''} ${item?.errorCode ?? ''} ${item?.error ?? ''}`.toLowerCase();
    return /rate.?limit|too.?many|429|retry.?after/.test(signal);
  };
  const transitorio = (item) => {
    if (infraestrutura(item)) return false;
    const signal = `${item?.state ?? ''} ${item?.errorCode ?? ''} ${item?.error ?? ''}`.toLowerCase();
    return /timeout|network/.test(signal);
  };
  const pressaoInfra = processed.filter(infraestrutura).length;
  const pressaoExplicita = processed.filter(explicito).length;
  const pressaoTransitoria = processed.filter((item) => !explicito(item) && transitorio(item)).length;
  const pressureCount = pressaoExplicita + pressaoTransitoria + pressaoInfra;

  const razaoDeColapso = Number.isFinite(options.collapseRatio)
    ? options.collapseRatio
    : adaptiveCollapsePressureRatio;
  // Sem lote, qualquer pressao conta como total - nao ha denominador para diluir.
  const razaoTransitoria = claimed > 0
    ? pressaoTransitoria / claimed
    : (pressaoTransitoria > 0 ? 1 : 0);

  if (pressaoExplicita > 0) return Math.max(1, Math.floor(current / 2));
  // Razao precisa de denominador. Com lote de 3, UM evento ja da 33% e supera
  // qualquer limiar razoavel -- entao abaixo da amostra minima a razao nao
  // informa nada e o unico efeito de aplica-la e a catraca medida em
  // 06/09/2026: 1, 2, 3, 1, 2, 3 sem fim, porque quanto menor o lote mais
  // sensivel ele fica e nao ha como sair. Abaixo do piso, erro transitorio
  // SEGURA em vez de derrubar; pressao explicita do provedor continua
  // derrubando em qualquer tamanho, porque ali quem falou foi o provedor.
  if (claimed >= AMOSTRA_MINIMA_DE_PRESSAO && razaoTransitoria >= razaoDeColapso) {
    return Math.max(1, Math.floor(current / 2));
  }
  // Ruido de rede abaixo do limiar: segura o crescimento sem punir. Era ele que
  // derrubava o controlador para 23.
  if (pressureCount > 0) return current;
  if (claimed >= current) return Math.min(maximum, current + Math.max(1, Math.ceil(current * 0.2)));
  return current;
}

// Fracao do lote que precisa dar sinal de pressao para o limite cair pela metade.
// Ver a prova no comentario de nextAdaptiveDispatchLimit. Configuravel para poder
// voltar ao comportamento antigo sem deploy: 0 faz qualquer erro derrubar, como
// era antes.
const adaptiveCollapsePressureRatio = (() => {
  const bruto = Number.parseFloat(process.env.PUBLICATION_WORKER_ADAPTIVE_COLLAPSE_RATIO || '');
  return Number.isFinite(bruto) && bruto >= 0 && bruto <= 1 ? bruto : 0.1;
})();

// Menor lote em que uma RAZAO de pressao significa alguma coisa. Com 10 itens,
// um evento e 10%; com 3, e 33%. Ver a prova no comentario do colapso.
const AMOSTRA_MINIMA_DE_PRESSAO = 10;

// Espera ate a primeira consulta de status do conteiner da Meta. Ver a medicao
// no ponto de uso. Configuravel para poder afinar sem deploy; o piso de 15 s e
// o da propria `defer_publication_item`.
const META_PRIMEIRA_CONSULTA_SEGUNDOS = integerEnv('PUBLICATION_WORKER_META_POLL_SECONDS', 30, 15, 300);

const adaptiveDispatchLimits = new Map();

export async function ignoreExpiredUnstartedPublications(supabase, options = {}) {
  const cutoffDelayMs = Number.isFinite(options.cutoffDelayMs)
    ? Math.max(60_000, Number(options.cutoffDelayMs))
    : 60_000;
  const cutoff = new Date((options.now ?? Date.now()) - cutoffDelayMs).toISOString();
  return { ignored: 0, pages: 0, cutoff, failed: false, automaticDiscardDisabled: true };
}

// JANELA DESLIZANTE (16/09/2026). Ver docs/fila-de-publicacao-MASTER.md, 8.3 e 12.
//
// O lote de `Promise.allSettled` so termina quando o item mais lento termina.
// Medido em 15/09/2026 pelo log por fase (`ociosidadeDoLote`): nos lotes cheios,
// 40-50 % do tempo de vaga ficava parado esperando o ultimo item, com o semaforo
// da Meta saturado (`esperaSemaforoMeta` p50 6-11 s). Aqui cada vaga que libera
// e reposta em pedacos, sob tres freios -- eles sao a diferenca entre "puxar
// quando sobra" e "martelar o claim", que varre a fila inteira para ordenar:
//
//   1. so repoe com >= `minVagasLivres` vagas livres (claim pequeno nao paga a RPC);
//   2. no maximo 1 claim a cada `intervaloEntreClaimsMs` por processo;
//   3. a janela tem duracao maxima (`janelaMaxMs`): depois disso nao repoe mais,
//      so espera o que esta em voo, e o ciclo segue para a manutencao (encerrar
//      atrasados, reconciliar lotes, resumo da fila), que fica FORA da janela.
//
// O teto de itens em voo continua sendo o limite adaptativo do ciclo. Claim que
// volta vazio encerra a reposicao (fila vazia); claim que falha tambem encerra e
// e devolvido em `erroDoClaim`, sem derrubar o que ja esta em voo. `processar` e
// `reivindicar` sao injetados para o teste nao precisar de banco nem de Meta.
export async function processarComJanelaDeslizante(options = {}) {
  const itens = Array.isArray(options.itens) ? [...options.itens] : [];
  const teto = Math.max(1, Math.floor(Number(options.teto) || 1));
  const minVagasLivres = Math.max(1, Math.floor(Number(options.minVagasLivres) || 6));
  const intervaloEntreClaimsMs = Math.max(0, Number(options.intervaloEntreClaimsMs ?? 3000));
  const janelaMaxMs = Math.max(0, Number(options.janelaMaxMs ?? 90_000));
  const agora = typeof options.now === 'function' ? options.now : Date.now;
  const dormir = typeof options.sleep === 'function' ? options.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  const reivindicar = typeof options.reivindicar === 'function' ? options.reivindicar : null;
  const processar = options.processar;
  if (typeof processar !== 'function') throw new TypeError('processarComJanelaDeslizante: `processar` e obrigatorio.');

  const resultados = [];
  const duracaoPorItem = [];
  const terminoPorItem = [];
  const inicio = agora();
  let ultimoClaimEm = inicio;
  let emVoo = 0;
  let reposicoes = 0;
  let itensRepostos = 0;
  let erroDoClaim = null;
  let motivoFim = reivindicar && itens.length > 0 ? null : 'sem_reposicao';
  let reposicaoAtiva = motivoFim === null;
  let claimEmAndamento = false;
  let esperaAgendada = false;

  let resolverFim;
  const fim = new Promise((resolve) => { resolverFim = resolve; });
  const talvezEncerrar = () => {
    if (emVoo === 0 && !claimEmAndamento && !esperaAgendada && !reposicaoAtiva) resolverFim();
  };
  const encerrarReposicao = (motivo) => {
    if (!reposicaoAtiva) return;
    reposicaoAtiva = false;
    motivoFim = motivoFim ?? motivo;
  };

  const lancar = (item, index) => {
    emVoo += 1;
    const comecouEm = agora();
    Promise.resolve()
      .then(() => processar(item, index))
      .then(
        (value) => { resultados[index] = { status: 'fulfilled', value }; },
        (reason) => { resultados[index] = { status: 'rejected', reason }; },
      )
      .finally(() => {
        const t = agora();
        duracaoPorItem.push(t - comecouEm);
        terminoPorItem.push(t);
        emVoo -= 1;
        void talvezRepor();
        talvezEncerrar();
      });
  };

  const talvezRepor = async () => {
    if (!reposicaoAtiva || claimEmAndamento || esperaAgendada) return;
    if (agora() - inicio >= janelaMaxMs) { encerrarReposicao('janela_maxima'); return; }
    const vagas = teto - emVoo;
    if (vagas < minVagasLivres) return;
    const restante = intervaloEntreClaimsMs - (agora() - ultimoClaimEm);
    if (restante > 0) {
      // Freio 2: espera o intervalo e reavalia; uma espera de cada vez.
      esperaAgendada = true;
      try { await dormir(restante); } finally { esperaAgendada = false; }
      if (!reposicaoAtiva) { talvezEncerrar(); return; }
      void talvezRepor();
      talvezEncerrar();
      return;
    }
    claimEmAndamento = true;
    ultimoClaimEm = agora();
    let novos = [];
    try {
      novos = (await reivindicar(vagas)) ?? [];
    } catch (erro) {
      erroDoClaim = erro;
      encerrarReposicao('claim_falhou');
    } finally {
      claimEmAndamento = false;
    }
    if (reposicaoAtiva) {
      if (!Array.isArray(novos) || novos.length === 0) {
        encerrarReposicao('fila_vazia');
      } else {
        reposicoes += 1;
        itensRepostos += novos.length;
        for (const item of novos.slice(0, Math.max(0, teto - emVoo))) {
          const index = itens.length;
          itens.push(item);
          lancar(item, index);
        }
      }
    }
    talvezEncerrar();
  };

  if (itens.length === 0) {
    return {
      itens, resultados, duracaoPorItem, terminoPorItem, fimDoLote: agora(),
      janelaMs: 0, reposicoes: 0, itensRepostos: 0, motivoFim: 'sem_itens', erroDoClaim: null,
    };
  }
  itens.forEach((item, index) => lancar(item, index));
  await fim;
  const fimDoLote = agora();
  return {
    itens, resultados, duracaoPorItem, terminoPorItem, fimDoLote,
    janelaMs: fimDoLote - inicio, reposicoes, itensRepostos, motivoFim: motivoFim ?? 'sem_reposicao', erroDoClaim,
  };
}

// Ligada por env para o canario: um processo com a janela, os outros com o lote
// de sempre. Os tres freios tambem sao env, com os valores da secao 12 do mestre.
const janelaDeslizanteLigada = /^(1|true|on|yes)$/i.test(`${process.env.PUBLICATION_WORKER_SLIDING_WINDOW ?? ''}`.trim());
const JANELA_MIN_VAGAS_LIVRES = integerEnv('PUBLICATION_WORKER_SLIDING_MIN_FREE_SLOTS', 6, 1, 100);
const JANELA_INTERVALO_ENTRE_CLAIMS_MS = integerEnv('PUBLICATION_WORKER_SLIDING_CLAIM_INTERVAL_MS', 3000, 500, 60_000);
const JANELA_DURACAO_MAX_MS = integerEnv('PUBLICATION_WORKER_SLIDING_WINDOW_MAX_MS', 90_000, 10_000, 600_000);

export async function dispatchPublicationQueueDirect(options = {}) {
  const workerId = options.workerId?.trim().slice(0, 120) || `direct-${randomUUID()}`;
  const configuredLimit = Number.isInteger(options.limit) ? Math.min(Math.max(options.limit, 1), 100) : 5;
  const reconciliationOnly = options.reconciliationOnly === true;
  const effectiveMaximum = reconciliationOnly ? Math.min(configuredLimit, 4) : configuredLimit;
  const limit = reconciliationOnly
    ? effectiveMaximum
    : adaptiveDispatchLimits.get(workerId) ?? Math.min(effectiveMaximum, 10);
  const leaseSeconds = Number.isInteger(options.leaseSeconds) ? Math.min(Math.max(options.leaseSeconds, 30), 900) : 180;
  const recoveryLimit = Number.isInteger(options.recoveryLimit) ? Math.min(Math.max(options.recoveryLimit, 0), limit) : 0;
  const supabase = createSupabase();
  // INSTRUMENTACAO POR FASE (31/08/2026). Este caminho era o unico ponto cego:
  // o caminho do spool ja tinha medicao, mas as ondas grandes passam por AQUI, e
  // sem numero por fase eu vinha adivinhando qual etapa consumia o tempo. Com 398
  // itens disponiveis e limite de 78, uma vazao de 33 criacoes/min implica ciclo
  // de ~2,4 minutos - e nada no despacho em si justifica isso.
  const cicloIniciadoEm = Date.now();
  const fases = {};
  let marcoAnterior = cicloIniciadoEm;
  const marcar = (nome) => { const agora = Date.now(); fases[nome] = agora - marcoAnterior; marcoAnterior = agora; };

  // Compatibilidade de telemetria: desde a 315, atraso causado pelo Athena
  // nunca é transformado automaticamente em estado terminal.
  const expired = reconciliationOnly
    ? { ignored: 0, pages: 0, cutoff: null, failed: false }
    : await ignoreExpiredUnstartedPublications(supabase);
  marcar('ignorarVencidos');
  // `skipPreparation` existe para quando a preparacao roda em laco proprio no
  // publication-worker: sem isso ela continuaria consumindo tempo do ciclo de
  // despacho, que e exatamente o acoplamento que a separacao veio desfazer.
  const preparation = (reconciliationOnly || options.skipPreparation === true)
    ? { claimed: 0, ready: 0, blocked: 0, errors: 0, results: [] }
    : await preparePublicationQueueDirect({
    workerId: `${workerId}:prepare`.slice(0, 120),
    limit: Number.isInteger(options.preparationLimit)
      ? options.preparationLimit
      : Math.min(500, Math.max(100, limit * 4)),
    concurrency: Number.isInteger(options.preparationConcurrency)
      ? options.preparationConcurrency
      : 4,
    leaseSeconds: Math.max(300, leaseSeconds),
    windowHours: 24,
    correlationId: options.correlationId,
  });
  marcar('preparacao');
  const recovery = reconciliationOnly
    ? { scanned: 0, rescheduled: 0, requiresAttention: 0, bulkSlotsAtRisk: 0, overdueAlerts: 0 }
    : await recoverMissedPublicationSchedules({ workerId, correlationId: options.correlationId });
  marcar('recuperarPerdidos');
  // O que a recuperacao nao alcancou e encerrado, e nao publicado atrasado.
  // Roda AQUI, no worker da VPS, e nao so no dispatcher do painel: em 06/09 a
  // varredura existia so no painel, que ainda nao tinha sido implantado, e um
  // reel de 89 minutos ficou em `waiting` para sempre -- recusado pelo claim,
  // mas ainda contado como vencido por todo o resto. Ele sozinho manteve
  // `criticalDelay` ligado e travou a exclusao de midia da galeria.
  const expirados = reconciliationOnly ? { expired: 0 } : await expireLatePublicationItems();
  marcar('encerrarAtrasados');
  if (!reconciliationOnly) await checarFilaDeConfirmacao();
  marcar('alarmeDeConfirmacao');
  // O resumo da tela e recalculado aqui, fora do caminho da requisicao.
  // MEDIDO EM 07/09/2026, sob carga: `resumoDaFila: 17453ms` dentro de um ciclo
  // de 56 s. Um terco do ciclo de DESPACHO gasto recalculando o resumo da TELA,
  // enquanto 800 itens venciam no mesmo minuto e 3.023 morriam no corte sem
  // nunca terem sido reivindicados.
  //
  // O resumo continua valendo (a leitura da /queue caiu de 8.941 ms para 125 ms
  // por causa dele) e continua rodando aqui, pelo motivo do commit f23d99e:
  // rotina que so existe no painel fica parada quando o painel nao e implantado.
  // O que muda e que ele deixa de SEGURAR o ciclo. Sem await, com trava propria
  // para nao empilhar, e com o erro isolado -- resumo e leitura, publicacao e
  // trabalho, e leitura nunca atrasa trabalho.
  // COM `await`, DE PROPOSITO -- e este comentario existe porque eu tirei o
  // await em 07/09/2026 e derrubei a Data API por 34 minutos.
  //
  // O `await` parecia desperdicio: 17 s de um ciclo de 56 s parados esperando
  // uma agregacao que so a tela consome. Tirei. Os ciclos ficaram rapidos na
  // hora (10,8 s) e por oito minutos pareceu certo.
  //
  // So que o `await` NAO era desperdicio, era CONTRAPRESSAO. Enquanto existia,
  // o recalculo se serializava sozinho: no maximo um por vez. Sem ele, cada
  // processo passou a disparar um agregado de ~29 s sobre 541 mil linhas a cada
  // 60 s sem esperar o anterior terminar -- e a trava `resumoEmAndamento` era
  // variavel de MODULO, valia por processo. Com 4 publicadores, quatro
  // agregados concorrentes. Os ciclos subiram de 10,8 s para 28 s em oito
  // minutos, o pool do PostgREST encheu, o cache de schema nao conseguiu
  // reconstruir e a API inteira caiu. So voltou com restart do projeto.
  //
  // A REGRA: contrapressao que voce remove precisa ser substituida por outra.
  // Aqui a substituta e nao precisar mais dela -- o dono do recalculo passou a
  // ser o cron da Vercel (vercel.json, de minuto em minuto) e este caminho e so
  // rede de seguranca para quando o painel nao estiver implantado. Rede de
  // seguranca roda em UM processo e pode esperar.
  if (queueSummaryEnabled && !reconciliationOnly) {
    try {
      await refreshQueueSummaries();
    } catch (erro) {
      console.error('[publication-worker] resumo da fila falhou', { message: erro?.message });
    }
  }
  marcar('resumoDaFila');
  const recoveryItems = reconciliationOnly ? [] : await claimCoordinatedBulkSlotRecoveryItems(
    workerId,
    recoveryLimit,
    leaseSeconds,
  );
  marcar('reivindicarRecuperacao');
  const remainingRegularCapacity = Math.max(0, limit - recoveryItems.length);
  let regularItems = [];
  if (remainingRegularCapacity > 0) {
    const claimFunction = reconciliationOnly
      ? 'claim_provider_accepted_publication_items'
      : 'claim_publication_items';
    const { data: claimed, error: claimError } = await supabase.rpc(claimFunction, {
      p_worker_id: workerId,
      p_limit: remainingRegularCapacity,
      p_lease_seconds: leaseSeconds,
    });
    if (claimError) throw claimError;
    regularItems = claimed ?? [];
  }
  marcar('claimNoBanco');
  const rotular = (item) => ({ ...item, correlation_id: options.correlationId ?? null });
  const itensIniciais = [...regularItems, ...recoveryItems].map(rotular);
  // Janela deslizante (canario por env) ou o lote de sempre. A reposicao usa o
  // mesmo claim regular, com o mesmo lease; itens de recuperacao coordenada so
  // entram no lote inicial.
  const janela = await processarComJanelaDeslizante({
    itens: itensIniciais,
    teto: limit,
    minVagasLivres: JANELA_MIN_VAGAS_LIVRES,
    intervaloEntreClaimsMs: JANELA_INTERVALO_ENTRE_CLAIMS_MS,
    janelaMaxMs: JANELA_DURACAO_MAX_MS,
    processar: (item) => processClaimedItem(item, workerId),
    reivindicar: (janelaDeslizanteLigada && !reconciliationOnly)
      ? async (vagas) => {
        const { data: novos, error: erroDoClaim } = await supabase.rpc('claim_publication_items', {
          p_worker_id: workerId,
          p_limit: vagas,
          p_lease_seconds: leaseSeconds,
        });
        if (erroDoClaim) throw erroDoClaim;
        return (novos ?? []).map(rotular);
      }
      : null,
  });
  if (janela.erroDoClaim) {
    console.error('[publication-worker] claim de reposicao da janela falhou', { workerId, message: errorInfo(janela.erroDoClaim).message });
  }
  const items = janela.itens;
  const settled = janela.resultados;
  const { duracaoPorItem, terminoPorItem, fimDoLote } = janela;
  marcar('processarItens');
  const processed = settled.map((entry, index) => entry.status === 'fulfilled'
    ? entry.value
    : { itemId: items[index].id, state: 'error', error: errorInfo(entry.reason).message ?? 'Falha desconhecida no processamento paralelo.' });
  // Log por fase: agrega os livros-razao do ciclo e os tira dos resultados, para
  // a telemetria por ciclo (publication_worker_cycle_events) nao crescer.
  const fasesPorItemMs = resumirFasesPorItem(processed.map((entry) => entry?.fasesMs));
  for (const entry of processed) if (entry && 'fasesMs' in entry) delete entry.fasesMs;
  const ociosidade = ociosidadeDoLote(duracaoPorItem, terminoPorItem, fimDoLote);
  // Consolida cada lote uma vez, fora das transacoes individuais. Tambem drena
  // resultados deixados por um ciclo anterior interrompido.
  const batchRuntime = await reconcilePublicationBatchRuntime(Math.min(500, Math.max(100, items.length)));
  marcar('reconciliarLotes');
  const nextLimit = reconciliationOnly
    ? effectiveMaximum
    : nextAdaptiveDispatchLimit(limit, effectiveMaximum, processed, items.length);
  if (!reconciliationOnly) adaptiveDispatchLimits.set(workerId, nextLimit);
  // A reciclagem vem após o dispatch: lentidão da Zernio não adia claims/publicações desta rodada.
  const finalizedSlotRecoveries = reconciliationOnly ? 0 : await finalizeCoordinatedBulkSlotRecoveryItems(workerId);
  marcar('finalizarRecuperacao');
  const recycling = reconciliationOnly ? [] : await processZernioProfileRecyclingJobs(workerId, Math.min(limit, 20));
  marcar('reciclagemZernio');

  const resumoPorItem = (() => {
    if (!duracaoPorItem.length) return null;
    const o = [...duracaoPorItem].sort((a, b) => a - b);
    const q = (p) => o[Math.min(o.length - 1, Math.floor(o.length * p))];
    return { n: o.length, p50: Math.round(q(0.5)), p90: Math.round(q(0.9)), max: Math.round(o[o.length - 1]) };
  })();
  console.info('[publication-worker] tempos do ciclo DIRETO', {
    workerId,
    itens: items.length,
    limiteAdaptativo: limit,
    cicloMs: Date.now() - cicloIniciadoEm,
    fasesMs: fases,
    porItemMs: resumoPorItem,
    fasesPorItemMs,
    ociosidadeDoLote: ociosidade,
    janelaDeslizante: janelaDeslizanteLigada
      ? { janelaMs: janela.janelaMs, reposicoes: janela.reposicoes, itensRepostos: janela.itensRepostos, motivoFim: janela.motivoFim }
      : null,
  });

  console.info('Dispatcher direto de publicação concluído.', {
    workerId,
    reconciliationOnly,
    expired,
    preparation: { claimed: preparation.claimed, ready: preparation.ready, blocked: preparation.blocked, errors: preparation.errors },
    recovery,
    coordinatedRecovery: { claimed: recoveryItems.length, finalized: finalizedSlotRecoveries },
    recycling: recycling.length,
    claimed: items.length,
    batchRuntime,
    adaptiveConcurrency: { used: limit, next: nextLimit, maximum: effectiveMaximum },
    states: processed.reduce((counts, item) => {
      counts[item.state] = (counts[item.state] ?? 0) + 1;
      return counts;
    }, {}),
  });
  return {
    workerId,
    reconciliationOnly,
    expired,
    preparation,
    recovery,
    coordinatedRecovery: { claimed: recoveryItems.length, finalized: finalizedSlotRecoveries },
    recycling,
    claimed: items.length,
    adaptiveConcurrency: { used: limit, next: nextLimit, maximum: effectiveMaximum },
    processed,
    batchRuntime,
  };
}
