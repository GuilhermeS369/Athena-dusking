import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

export const PUBLICATION_MAX_ATTEMPTS = 5;

const graphVersion = process.env.META_GRAPH_API_VERSION ?? 'v26.0';
const metaRequestTimeoutMs = 25_000;
const maxConcurrentMetaRequests = integerEnv('PUBLICATION_WORKER_META_CONCURRENCY', 5, 1, 20);
const zernioBaseUrl = process.env.ZERNIO_API_BASE_URL ?? 'https://zernio.com/api';
const zernioRequestTimeoutMs = integerEnv('ZERNIO_REQUEST_TIMEOUT_MS', 45_000, 25_000, 90_000);
const zernioCreateMinimumSpacingMs = integerEnv('PUBLICATION_WORKER_ZERNIO_CREATE_SPACING_MS', 75, 0, 2_000);
const zernioCreateBackpressureSpacingMs = integerEnv('PUBLICATION_WORKER_ZERNIO_BACKPRESSURE_SPACING_MS', 200, 25, 5_000);
const mediaProbeTimeoutMs = integerEnv('PUBLICATION_MEDIA_URL_PROBE_TIMEOUT_MS', 12_000, 1_000, 30_000);

let activeMetaRequests = 0;
const pendingMetaRequests = [];
const zernioTelemetry = new Map();
const zernioTelemetryAnomalies = [];
let nextZernioCreateStartAt = 0;
let zernioBackpressureUntil = 0;

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

async function withMetaRequestLimit(operation) {
  if (activeMetaRequests >= maxConcurrentMetaRequests) await new Promise((resolve) => pendingMetaRequests.push(resolve));
  activeMetaRequests += 1;
  try {
    return await operation();
  } finally {
    activeMetaRequests -= 1;
    pendingMetaRequests.shift()?.();
  }
}

function metaFetch(input, init) {
  return withMetaRequestLimit(() => fetch(input, init));
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

function activateZernioBackpressure(error) {
  const outcome = zernioOutcome(error);
  if (outcome === 'timeout' || outcome === 'network_error' || error?.httpStatus === 429 || error?.httpStatus >= 500) {
    zernioBackpressureUntil = Math.max(zernioBackpressureUntil, Date.now() + 5 * 60_000);
  }
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

async function createTemporaryUrl(storagePath) {
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

export async function probeMediaUrl(url, kind, options = {}) {
  const fetchImpl = options.fetch ?? fetch;
  const probe = async (method, range = false) => {
    const response = await fetchImpl(url, {
      method,
      headers: range ? { Range: 'bytes=0-1023' } : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(mediaProbeTimeoutMs),
    });
    const contentType = response.headers.get('content-type') ?? '';
    await response.body?.cancel().catch(() => undefined);
    return { response, contentType };
  };

  let result;
  try {
    result = await probe('HEAD');
  } catch (error) {
    if (error?.name === 'TimeoutError') throw mediaDeliveryError('A verificação externa da URL da mídia expirou.', 'media_url_probe_timeout');
    throw mediaDeliveryError('Não foi possível verificar externamente a URL da mídia.', 'media_url_probe_network');
  }
  if (!result.response.ok || !expectedMediaMime(kind, result.contentType)) {
    try {
      result = await probe('GET', true);
    } catch (error) {
      if (error?.name === 'TimeoutError') throw mediaDeliveryError('A leitura parcial da URL da mídia expirou.', 'media_url_range_probe_timeout');
      throw mediaDeliveryError('Não foi possível ler externamente a URL da mídia.', 'media_url_range_probe_network');
    }
  }
  if (!result.response.ok) throw mediaDeliveryError(`A URL temporária da mídia retornou HTTP ${result.response.status}.`, `media_url_probe_http_${result.response.status}`, result.response.status >= 500);
  if (!expectedMediaMime(kind, result.contentType)) throw mediaDeliveryError('A URL temporária retornou um tipo de conteúdo incompatível com a mídia.', 'media_url_probe_mime_invalid', false);
  return { url, fingerprint: urlFingerprint(url), httpStatus: result.response.status, contentType: result.contentType };
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
    error.retryable = response.status >= 500 || response.status === 429 || body.error?.is_transient === true;
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
  });
  const result = await readInstagramResponse(response);
  if (!result.id) throw new Error('Instagram não retornou o creation_id do contêiner.');
  return result.id;
}

async function containerStatus(creationId, accessToken) {
  const url = new URL(graphUrl(encodeURIComponent(creationId)));
  url.searchParams.set('fields', 'status_code');
  const response = await metaFetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(metaRequestTimeoutMs),
  });
  return readInstagramResponse(response);
}

async function publishInstagramContainer(profileId, creationId, accessToken) {
  const response = await metaFetch(graphUrl(`${encodeURIComponent(profileId)}/media_publish`), {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ creation_id: creationId }),
    cache: 'no-store',
    signal: AbortSignal.timeout(metaRequestTimeoutMs),
  });
  const result = await readInstagramResponse(response);
  if (!result.id) throw new Error('Instagram não retornou o media_id publicado.');
  return result.id;
}

async function createParentContainer(item, accessToken) {
  if (item.media.length === 0) throw publicationDataError('O item da publicação não possui mídia vinculada.');
  if (item.format === 'carousel' && (item.media.length < 2 || item.media.length > 10)) throw publicationDataError('O carrossel deve possuir entre 2 e 10 mídias.');
  if (item.format !== 'carousel' && item.media.length !== 1) throw publicationDataError('Este formato de publicação requer exatamente uma mídia.');

  const urls = await buildVerifiedMediaUrls(item);
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
    if (status.status_code === 'FINISHED') {
      if (beforePublish && !await beforePublish()) return { state: 'deferred', reason: 'daily_profile_limit' };
      return { state: 'published', metaMediaId: await publishInstagramContainer(item.profile.instagram_user_id, item.creation_id, accessToken) };
    }
    if (status.status_code === 'PUBLISHED') return { state: 'published', metaMediaId: null, recovered: true };
    if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
      return { state: 'failed', retryable: false, errorCode: status.status_code, errorMessage: `Instagram informou ${status.status_code} ao preparar a publicação.` };
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
    listPosts(query = {}) {
      return request('/v1/posts', { query });
    },
    disconnectAccount(accountId, requestId) {
      return request(`/v1/accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE', requestId });
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
      return decodeURIComponent(new URL(url).pathname).endsWith(`/${media.storage_path}`);
    } catch {
      return url.includes(media.storage_path);
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

async function buildZernioMediaItems(item) {
  const urls = await buildVerifiedMediaUrls(item);
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

function platformSpecificData(format) {
  if (format === 'story') return { contentType: 'story' };
  if (format === 'reel') return { shareToFeed: true };
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
  const specificData = platformSpecificData(item.format);
  const response = await client.createPost({
    content: item.caption ?? '',
    mediaItems: await buildZernioMediaItems(item),
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
      .select('container_poll_count, provider_creation_started_at, zernio_recovery_count, zernio_recovery_poll_at')
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
  };
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

  return message;
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

async function processZernioProfileRecyclingJobs(workerId, limit = 10) {
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
    return { jobId: job.job_id, outcome, result: data };
  }));
  return processed.map((entry, index) => entry.status === 'fulfilled'
    ? entry.value
    : { jobId: jobs[index].job_id, outcome: 'error', error: errorInfo(entry.reason).message });
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

async function reservePublicationDispatchCapacity(item, workerId) {
  const supabase = createSupabase();
  const { data, error } = await supabase.rpc('reserve_publication_dispatch_capacity', {
    p_item_id: item.id,
    p_worker_id: workerId,
    p_reservation_seconds: 300,
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

export async function processClaimedItem(item, workerId) {
  const supabase = createSupabase();
  let capacityReserved = false;
  try {
    const workItem = await loadWorkItem(item);
    if ('state' in workItem && workItem.state === 'suspended') {
      await suspendClaimedPublication(item, workerId, workItem.errorMessage);
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
      if (!await claimedProfileRemainsOnline(item, workerId)) return false;
      const fairnessAllowed = await reservePublicationDispatchCapacity(item, workerId);
      if (!fairnessAllowed) return false;
      capacityReserved = true;
      if (workItem.profile.provider !== 'zernio') {
        const dailyAllowed = await reserveDailyPublicationLimit(item.id, workerId);
        if (!dailyAllowed) await releasePublicationDispatchCapacity(item.id);
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
          () => claimedProfileRemainsOnline(item, workerId),
        );

    if (workItem.profile?.provider === 'zernio' && result.state === 'processing') {
      result = zernioProcessingDeadlineFailure(workItem, result) ?? result;
    }

    if (result.state === 'suspended') {
      await suspendClaimedPublication(item, workerId, result.errorMessage);
      return { itemId: item.id, state: 'suspended' };
    }

    if (result.state === 'processing') {
      const { error } = await supabase.rpc('defer_publication_item', {
        p_item_id: item.id,
        p_worker_id: workerId,
        p_creation_id: result.creationId,
        p_delay_seconds: workItem.profile.provider === 'zernio'
          ? zernioPollingDelaySeconds(workItem)
          : 60,
        p_is_poll: Boolean(item.creation_id),
      });
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
      && isMetaTerminalProfileDisconnection(result)) {
      const disconnection = await finalizeMetaProfileDisconnection(workItem, workerId, result);
      if (capacityReserved) await releasePublicationDispatchCapacity(item.id);
      return { itemId: item.id, state: 'meta_profile_removed', disconnection };
    }

    if (workItem.profile.provider === 'zernio'
      && workItem.format === 'reel'
      && result.state === 'failed'
      && item.creation_id
      && isProviderMediaDownloadFailure(result)
      && workItem.zernio_recovery_count === 0) {
      if (workItem.container_poll_count === 0) {
        await deferFirstZernioMediaDownloadFailure(workItem, workerId);
        if (capacityReserved) await releasePublicationDispatchCapacity(item.id);
        return { itemId: item.id, state: 'zernio_media_download_second_poll_scheduled' };
      }
      const recovered = await scheduleZernioMediaDownloadRecovery(workItem, workerId, result);
      if (recovered) {
        if (capacityReserved) await releasePublicationDispatchCapacity(item.id);
        return { itemId: item.id, state: 'zernio_media_recovery_scheduled' };
      }
      // O RPC retorna false por política: preservamos a falha original como
      // terminal e nunca geramos uma segunda criação externa.
    }

    if (result.state === 'deferred') return { itemId: item.id, state: result.reason };

    const { error } = await supabase.rpc('complete_publication_item', {
      p_item_id: item.id,
      p_worker_id: workerId,
      p_outcome: result.state === 'published' ? 'published' : result.state === 'removed' ? 'removed' : 'failed',
      p_meta_media_id: result.state === 'published' ? result.metaMediaId : null,
      p_error_code: result.state === 'failed' || result.state === 'removed' ? result.errorCode : null,
      p_error_message: result.state === 'failed' || result.state === 'removed' ? result.errorMessage : null,
      p_retryable: result.state === 'failed' && result.retryable,
      p_max_attempts: PUBLICATION_MAX_ATTEMPTS,
    });
    if (error) {
      if (result.state === 'published') await preserveConfirmedPublication(item.id, workerId, result.metaMediaId);
      else throw error;
    }
    if (capacityReserved) await releasePublicationDispatchCapacity(item.id);

    return { itemId: item.id, state: result.state, recovered: result.state === 'published' && result.recovered === true };
  } catch (error) {
    if (capacityReserved) await releasePublicationDispatchCapacity(item.id);
    const message = await recoverUnexpectedDispatcherFailure(item.id, workerId, error);
    console.error('Falha isolada no dispatcher direto de publicação.', { itemId: item.id, error: errorInfo(error), message });
    return { itemId: item.id, state: 'error', error: message };
  }
}

export async function dispatchPublicationQueueDirect(options = {}) {
  const workerId = options.workerId?.trim().slice(0, 120) || `direct-${randomUUID()}`;
  const limit = Number.isInteger(options.limit) ? Math.min(Math.max(options.limit, 1), 100) : 5;
  const leaseSeconds = Number.isInteger(options.leaseSeconds) ? Math.min(Math.max(options.leaseSeconds, 30), 900) : 180;
  const recoveryLimit = Number.isInteger(options.recoveryLimit) ? Math.min(Math.max(options.recoveryLimit, 0), limit) : 0;
  const supabase = createSupabase();
  const recovery = await recoverMissedPublicationSchedules({ workerId, correlationId: options.correlationId });
  const recoveryItems = await claimCoordinatedBulkSlotRecoveryItems(
    workerId,
    recoveryLimit,
    leaseSeconds,
  );
  const remainingRegularCapacity = Math.max(0, limit - recoveryItems.length);
  let regularItems = [];
  if (remainingRegularCapacity > 0) {
    const { data: claimed, error: claimError } = await supabase.rpc('claim_publication_items', {
      p_worker_id: workerId,
      p_limit: remainingRegularCapacity,
      p_lease_seconds: leaseSeconds,
    });
    if (claimError) throw claimError;
    regularItems = claimed ?? [];
  }
  const items = [...regularItems, ...recoveryItems].map((item) => ({ ...item, correlation_id: options.correlationId ?? null }));
  const settled = await Promise.allSettled(items.map((item) => processClaimedItem(item, workerId)));
  const processed = settled.map((entry, index) => entry.status === 'fulfilled'
    ? entry.value
    : { itemId: items[index].id, state: 'error', error: errorInfo(entry.reason).message ?? 'Falha desconhecida no processamento paralelo.' });
  // A reciclagem vem após o dispatch: lentidão da Zernio não adia claims/publicações desta rodada.
  const finalizedSlotRecoveries = await finalizeCoordinatedBulkSlotRecoveryItems(workerId);
  const recycling = await processZernioProfileRecyclingJobs(workerId, Math.min(limit, 20));

  console.info('Dispatcher direto de publicação concluído.', {
    workerId,
    recovery,
    coordinatedRecovery: { claimed: recoveryItems.length, finalized: finalizedSlotRecoveries },
    recycling: recycling.length,
    claimed: items.length,
    states: processed.reduce((counts, item) => {
      counts[item.state] = (counts[item.state] ?? 0) + 1;
      return counts;
    }, {}),
  });
  return {
    workerId,
    recovery,
    coordinatedRecovery: { claimed: recoveryItems.length, finalized: finalizedSlotRecoveries },
    recycling,
    claimed: items.length,
    processed,
  };
}
