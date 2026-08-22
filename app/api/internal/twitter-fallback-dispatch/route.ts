import { randomUUID, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { decryptToken } from '@/lib/security/token-crypto';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { isTwitterPrimaryHeartbeatFresh, twitterFallbackExecutionMode } from '@/lib/twitter/fallback';
import { classifyTwitterProviderResponse } from '@/scripts/workers/twitter-provider-classification.mjs';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type ClaimItem = {
  item_id: string;
  attempt_id: string;
  content: string;
  account_id?: string;
  encrypted_api_key?: string;
  media?: Array<{ type: string; url: string }>;
};

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function authorized(request: Request) {
  const supplied = [request.headers.get('x-twitter-worker-secret'), request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')].filter((value): value is string => Boolean(value));
  const expected = [process.env.TWITTER_WORKER_SECRET, process.env.CRON_SECRET].filter((value): value is string => Boolean(value));
  return expected.some((secret) => supplied.some((candidate) => safeEqual(secret, candidate)));
}

function integerEnv(name: string, fallback: number, minimum: number, maximum: number) {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, minimum), maximum) : fallback;
}

async function internalPost(request: Request, path: string, body: unknown) {
  const secret = process.env.TWITTER_WORKER_SECRET;
  if (!secret) throw new Error('Segredo do worker Twitter ausente.');
  const response = await fetch(new URL(path, request.url), { method: 'POST', headers: { 'content-type': 'application/json', 'x-twitter-worker-secret': secret }, body: JSON.stringify(body), cache: 'no-store' });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : `Rota interna retornou HTTP ${response.status}.`);
  return payload;
}

async function reportResult(request: Request, item: ClaimItem, resolution: string, fields: Record<string, unknown> = {}) {
  return internalPost(request, '/api/internal/twitter-publication-results', {
    attemptId: item.attempt_id,
    idempotencyKey: `fallback-result:${item.attempt_id}:${resolution}`,
    phase: 'publication',
    resolution,
    ...fields,
    evidence: { worker: 'vercel-twitter-fallback', fallback: true },
  });
}

async function publish(request: Request, item: ClaimItem) {
  if (!item.account_id || !item.encrypted_api_key) throw new Error('Claim live do fallback está incompleto.');
  await internalPost(request, '/api/internal/twitter-publication-start', { attemptId: item.attempt_id, idempotencyKey: `fallback-start:${item.attempt_id}` });
  let response: Response;
  let payload: unknown = {};
  try {
    response = await fetch(`${process.env.ZERNIO_API_BASE_URL ?? 'https://zernio.com/api'}/v1/posts`, {
      method: 'POST',
      headers: { authorization: `Bearer ${decryptToken(item.encrypted_api_key)}`, 'content-type': 'application/json', 'idempotency-key': `athena-twitter-${item.item_id}` },
      body: JSON.stringify({ content: item.content, mediaItems: item.media ?? [], platforms: [{ platform: 'twitter', accountId: item.account_id }], publishNow: true }),
      signal: AbortSignal.timeout(integerEnv('TWITTER_ZERNIO_REQUEST_TIMEOUT_MS', 30_000, 5_000, 45_000)),
      cache: 'no-store',
    });
    payload = await response.json().catch(() => ({}));
  } catch (error) {
    return reportResult(request, item, 'outcome_unknown', { message: error instanceof Error ? error.message.slice(0, 700) : 'Falha de rede Zernio.' });
  }
  const classified = classifyTwitterProviderResponse({ ok: response.ok, status: response.status, payload, requestId: response.headers.get('x-request-id'), retryAfter: response.headers.get('retry-after') });
  const { resolution, ...fields } = classified;
  return reportResult(request, item, resolution, fields);
}

export async function POST(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });
  const mode = twitterFallbackExecutionMode({
    TWITTER_FALLBACK_ENABLED: process.env.TWITTER_FALLBACK_ENABLED,
    TWITTER_FALLBACK_LIVE_ENABLED: process.env.TWITTER_FALLBACK_LIVE_ENABLED,
    TWITTER_PUBLICATION_WORKER_ENABLED: process.env.TWITTER_PUBLICATION_WORKER_ENABLED,
    TWITTER_PUBLICATION_MODE: process.env.TWITTER_PUBLICATION_MODE,
  });
  if (mode === 'disabled') return NextResponse.json({ disabled: true, claimed: 0 });
  const admin = createSupabaseAdminClient();
  const staleAfterSeconds = integerEnv('TWITTER_FALLBACK_STALE_SECONDS', 120, 30, 900);
  const [{ data: heartbeat }, { data: breaker, error: breakerError }] = await Promise.all([
    admin.from('twitter_worker_heartbeats').select('mode,last_seen_at').eq('worker_name', 'athena-twitter-publication-worker').maybeSingle(),
    admin.rpc('twitter_worker_circuit_breaker', { p_scope_key: 'worker:athena-twitter-publication-worker', p_operation: 'check', p_reason: null, p_threshold: 5, p_cooldown_seconds: 300 }),
  ]);
  if (breakerError) return NextResponse.json({ error: 'Circuit breaker X indisponível.' }, { status: 503 });
  if (breaker?.allowed === false) return NextResponse.json({ skipped: true, claimed: 0, reason: 'circuit_breaker_open' });
  if (isTwitterPrimaryHeartbeatFresh(heartbeat, Date.now(), staleAfterSeconds)) return NextResponse.json({ skipped: true, claimed: 0, reason: 'vps_twitter_worker_active', staleAfterSeconds });

  try {
    await admin.rpc('twitter_record_worker_heartbeat', { p_worker_name: 'athena-twitter-vercel-fallback', p_worker_id: `vercel-${randomUUID()}`, p_mode: mode, p_metadata: { fallback: true, runtime: 'vercel' } });
    const claim = await internalPost(request, '/api/internal/twitter-publication-claims', { workerId: `vercel-fallback-${randomUUID()}`, limit: 1 });
    const items = Array.isArray(claim.items) ? claim.items as ClaimItem[] : [];
    const item = items[0];
    if (!item) return NextResponse.json({ fallback: true, mode, claimed: 0 });
    if (mode === 'shadow') {
      await internalPost(request, '/api/internal/twitter-publication-results', { attemptId: item.attempt_id, idempotencyKey: `fallback-shadow:${item.attempt_id}`, mode: 'shadow' });
    } else {
      await publish(request, item);
    }
    return NextResponse.json({ fallback: true, mode, claimed: 1, itemId: item.item_id });
  } catch (error) {
    await admin.rpc('twitter_worker_circuit_breaker', { p_scope_key: 'worker:athena-twitter-publication-worker', p_operation: 'failure', p_reason: error instanceof Error ? error.message.slice(0, 500) : 'Falha fallback Vercel.', p_threshold: 5, p_cooldown_seconds: 300 });
    return NextResponse.json({ error: 'Fallback Twitter indisponível.' }, { status: 503 });
  }
}

export async function GET(request: Request) {
  return POST(request);
}
