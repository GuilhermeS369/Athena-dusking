function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function normalizeTwitterProviderResponseBody(rawText) {
  const text = String(rawText ?? '').trim();
  if (!text) return { payload: {}, responseKind: 'empty' };
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'string' && /^https?:\/\//i.test(parsed.trim())) return { payload: { code: 'unexpected_url_response', message: 'A Zernio retornou uma URL onde era esperado o resultado do post.', responseKind: 'url' }, responseKind: 'url' };
    return { payload: parsed, responseKind: 'json' };
  } catch {
    if (/^https?:\/\//i.test(text)) return { payload: { code: 'unexpected_url_response', message: 'A Zernio retornou uma URL onde era esperado o resultado do post.', responseKind: 'url' }, responseKind: 'url' };
    return { payload: { code: 'unexpected_text_response', message: text.slice(0, 700), responseKind: 'text' }, responseKind: 'text' };
  }
}

export function terminalTwitterDisconnectionSignal(value) {
  const body = record(value); const nested = record(body.error);
  const code = String(body.code ?? nested.code ?? '').trim().toLowerCase();
  if (code === 'account_disconnected') return 'account_disconnected';
  if (code === 'auth_expired') return 'auth_expired';
  return null;
}

function postId(value) {
  const payload = record(value);
  return [payload._id, payload.id].find((entry) => typeof entry === 'string' && entry.length > 0) ?? null;
}

function platformStatus(value) {
  const payload = record(value);
  const platforms = Array.isArray(payload.platforms) ? payload.platforms.map(record) : [];
  return String(platforms.find((entry) => entry.platform === 'twitter')?.status ?? payload.status ?? '').toLowerCase();
}

export function classifyTwitterProviderResponse({ ok, status, payload, requestId = null, retryAfter = null }) {
  const body = record(payload);
  const nested = record(body.error);
  const providerCode = String(body.code ?? nested.code ?? status);
  const disconnectSignal = terminalTwitterDisconnectionSignal(body);
  if (body.responseKind === 'url' || body.responseKind === 'text') return { resolution: ok ? 'outcome_unknown' : 'confirmed_failure', httpStatus: status, providerCode, requestId, message: String(body.message ?? 'Resposta inesperada da Zernio.').slice(0, 700) };
  if (!ok) {
    const existing = body.existingPostId ?? record(body.details).existingPostId ?? nested.existingPostId;
    if (existing) return { resolution: 'existing_post', httpStatus: status, providerCode, requestId, postId: String(existing), message: 'Post existente confirmado.' };
    if (status === 429) {
      const parsedRetry = Number.parseInt(String(retryAfter ?? '0'), 10);
      return { resolution: 'rate_limited', httpStatus: 429, providerCode, requestId, retryAfterSeconds: Math.max(Number.isFinite(parsedRetry) ? parsedRetry : 0, 240), message: 'Rate limit Zernio/X.' };
    }
    return { resolution: status >= 500 ? 'outcome_unknown' : 'confirmed_failure', httpStatus: status, providerCode: disconnectSignal ?? providerCode, requestId, message: String(body.message ?? nested.message ?? `HTTP ${status}`).slice(0, 700) };
  }
  const existing = body.existingPost;
  const remote = body.post ?? existing ?? {};
  const remoteStatus = platformStatus(remote);
  const resolution = existing ? 'existing_post' : ['published', 'success', 'posted', 'completed'].includes(remoteStatus) ? 'published' : ['failed', 'error', 'rejected', 'cancelled'].includes(remoteStatus) ? 'confirmed_failure' : 'accepted';
  return { resolution, httpStatus: status, providerCode: remoteStatus || 'accepted', requestId, postId: postId(remote), message: `Resultado Zernio: ${remoteStatus || 'aceito'}.` };
}

export function classifyTwitterAnalyticsResponse({ ok, status }) {
  if (status === 202) return 'outcome_unknown';
  if (ok) return 'succeeded';
  return status >= 500 ? 'outcome_unknown' : 'failed';
}
