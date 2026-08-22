import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { classifyTwitterRolloutHealth, summarizeTwitterWorkers, twitterRolloutScope, TWITTER_WORKER_NAMES, type TwitterWorkerHeartbeat } from '@/lib/twitter/rollout-health';

export const dynamic = 'force-dynamic';

type QueryError = { message: string } | null;
type CountResult = { count: number | null; error: QueryError };
type WalletRow = { posted_balance_micros: number | string; reserved_micros: number | string };
type BreakerRow = { scope_key: string; state: string; failure_count: number; updated_at: string };

function safeEqual(left: string, right: string) {
  const expected = Buffer.from(left);
  const supplied = Buffer.from(right);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

function authorized(request: Request) {
  const expected = [process.env.TWITTER_ROLLOUT_HEALTH_SECRET, process.env.CRON_SECRET].filter((value): value is string => Boolean(value));
  const supplied = [request.headers.get('x-twitter-worker-secret'), request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')].filter((value): value is string => Boolean(value));
  return expected.some((secret) => supplied.some((candidate) => safeEqual(secret, candidate)));
}

function integerEnv(name: string, fallback: number, minimum: number, maximum: number) {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, minimum), maximum) : fallback;
}

async function exactCount(query: PromiseLike<CountResult>) {
  const { count, error } = await query;
  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function readWallets(admin: ReturnType<typeof createSupabaseAdminClient>) {
  const rows: WalletRow[] = [];
  const pageSize = 1_000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await admin.from('twitter_wallets').select('posted_balance_micros,reserved_micros').range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as WalletRow[]));
    if ((data?.length ?? 0) < pageSize) return rows;
  }
}

function micros(value: number | string) {
  return BigInt(String(value));
}

export async function GET(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });

  try {
    const admin = createSupabaseAdminClient();
    const now = new Date();
    const nowIso = now.toISOString();
    const sinceIso = new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString();
    const staleAfterSeconds = integerEnv('TWITTER_ROLLOUT_HEALTH_STALE_SECONDS', 120, 30, 900);
    const count = (table: string) => admin.from(table).select('*', { count: 'exact', head: true });

    const [
      publicationNonTerminal, publicationReady, publicationRetry, publicationClaimed, publicationProcessing, publicationUnknown,
      analyticsReserved, analyticsProcessing, analyticsUnknown, reservedHolds, activeHolds, unknownHolds, unknownReservations,
      publicationRateLimits, analyticsRateLimits, heartbeatsResult, breakersResult, wallets,
    ] = await Promise.all([
      exactCount(count('twitter_publication_items').in('status', ['ready', 'retry', 'claimed', 'processing', 'outcome_unknown'])),
      exactCount(count('twitter_publication_items').eq('status', 'ready')),
      exactCount(count('twitter_publication_items').eq('status', 'retry')),
      exactCount(count('twitter_publication_items').eq('status', 'claimed')),
      exactCount(count('twitter_publication_items').eq('status', 'processing')),
      exactCount(count('twitter_publication_items').eq('status', 'outcome_unknown')),
      exactCount(count('twitter_analytics_items').eq('status', 'reserved')),
      exactCount(count('twitter_analytics_items').eq('status', 'processing')),
      exactCount(count('twitter_analytics_items').eq('status', 'outcome_unknown')),
      exactCount(count('twitter_item_holds').eq('status', 'reserved')),
      exactCount(count('twitter_item_holds').eq('status', 'active')),
      exactCount(count('twitter_item_holds').eq('status', 'outcome_unknown')),
      exactCount(count('twitter_wallet_reservations').eq('status', 'outcome_unknown')),
      exactCount(count('twitter_publication_attempts').eq('http_status', 429).gte('created_at', sinceIso)),
      exactCount(count('twitter_analytics_attempts').eq('http_status', 429).gte('started_at', sinceIso)),
      admin.from('twitter_worker_heartbeats').select('worker_name,mode,last_seen_at').in('worker_name', [...TWITTER_WORKER_NAMES]),
      admin.from('twitter_circuit_breakers').select('scope_key,state,failure_count,updated_at').like('scope_key', 'worker:athena-twitter-%'),
      readWallets(admin),
    ]);

    if (heartbeatsResult.error || breakersResult.error) throw new Error(heartbeatsResult.error?.message ?? breakersResult.error?.message ?? 'Telemetria X indisponível.');

    const workers = summarizeTwitterWorkers((heartbeatsResult.data ?? []) as TwitterWorkerHeartbeat[], process.env, now.getTime(), staleAfterSeconds);
    const breakers = (breakersResult.data ?? []) as BreakerRow[];
    const openBreakers = breakers.filter((breaker) => breaker.state !== 'closed');
    const rolloutScope = twitterRolloutScope(process.env);
    const pausedQueueItems = rolloutScope.active ? 0 : publicationNonTerminal + analyticsReserved + analyticsProcessing;
    const health = classifyTwitterRolloutHealth({
      staleWorkers: workers.filter((worker) => worker.state === 'stale').length,
      openBreakers: openBreakers.length,
      publicationUnknown,
      analyticsUnknown,
      unknownHolds,
      unknownReservations,
      pausedQueueItems,
      recentRateLimits: publicationRateLimits + analyticsRateLimits,
    });

    const totalPosted = wallets.reduce((total, wallet) => total + micros(wallet.posted_balance_micros), BigInt(0));
    const totalReserved = wallets.reduce((total, wallet) => total + micros(wallet.reserved_micros), BigInt(0));
    const protectedFloor = BigInt(5_000_000);
    const walletsAtOrBelowFloor = wallets.filter((wallet) => micros(wallet.posted_balance_micros) - micros(wallet.reserved_micros) <= protectedFloor).length;

    return NextResponse.json({
      ok: health.status !== 'unhealthy',
      status: health.status,
      module: {
        enabled: rolloutScope.active,
        globalEnabled: rolloutScope.globalEnabled,
        canaryOrganizationCount: rolloutScope.canaryOrganizationCount,
        publicationWorkerEnabled: process.env.TWITTER_PUBLICATION_WORKER_ENABLED === 'true',
        analyticsEnabled: process.env.TWITTER_ANALYTICS_ENABLED === 'true' && process.env.TWITTER_ANALYTICS_WORKER_ENABLED === 'true',
        fallbackEnabled: process.env.TWITTER_FALLBACK_ENABLED === 'true',
        fallbackLiveEnabled: process.env.TWITTER_FALLBACK_LIVE_ENABLED === 'true',
      },
      publicationQueue: { nonTerminal: publicationNonTerminal, ready: publicationReady, retry: publicationRetry, claimed: publicationClaimed, processing: publicationProcessing, outcomeUnknown: publicationUnknown },
      analyticsQueue: { reserved: analyticsReserved, processing: analyticsProcessing, outcomeUnknown: analyticsUnknown },
      holds: { reserved: reservedHolds, active: activeHolds, outcomeUnknown: unknownHolds, reservationOutcomeUnknown: unknownReservations },
      rateLimits24h: { publication: publicationRateLimits, analytics: analyticsRateLimits },
      wallets: {
        count: wallets.length,
        withReservations: wallets.filter((wallet) => micros(wallet.reserved_micros) > BigInt(0)).length,
        atOrBelowProtectedAnalyticsFloor: walletsAtOrBelowFloor,
        postedMicros: totalPosted.toString(),
        reservedMicros: totalReserved.toString(),
        availableMicros: (totalPosted - totalReserved).toString(),
      },
      workers: { staleAfterSeconds, entries: workers },
      circuitBreakers: { open: openBreakers.length, entries: breakers.map((breaker) => ({ scope: breaker.scope_key, state: breaker.state, failures: breaker.failure_count, updatedAt: breaker.updated_at })) },
      signals: { critical: health.criticalSignals, warning: health.warningSignals, pausedQueueItems },
      checkedAt: nowIso,
    }, { status: health.status === 'unhealthy' ? 503 : 200, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[twitter-rollout-health] read failed', { message: error instanceof Error ? error.message : 'Falha desconhecida.' });
    return NextResponse.json({ error: 'Saúde do rollout X indisponível.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
