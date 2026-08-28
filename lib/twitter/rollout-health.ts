export const TWITTER_WORKER_NAMES = [
  'athena-twitter-publication-worker',
  'athena-twitter-preparation-worker',
  'athena-twitter-zernio-sync-worker',
  'athena-twitter-analytics-worker',
  'athena-twitter-webhook-reconcile-worker',
  'athena-twitter-connect-worker',
  'athena-twitter-observability-worker',
  'athena-twitter-vercel-fallback',
] as const;

export type TwitterWorkerName = (typeof TWITTER_WORKER_NAMES)[number];

export type TwitterWorkerHeartbeat = {
  worker_name: string;
  mode: string;
  last_seen_at: string;
};

type TwitterRolloutEnvironment = Record<string, string | undefined>;

function enabled(value: string | undefined) {
  return value?.trim().toLowerCase() === 'true';
}

export function twitterRolloutScope(environment: TwitterRolloutEnvironment) {
  const canaryOrganizationCount = new Set((environment.TWITTER_CANARY_ORGANIZATION_IDS ?? '').split(',').map((value) => value.trim()).filter(Boolean)).size;
  const globalEnabled = enabled(environment.TWITTER_MODULE_ENABLED);
  return { globalEnabled, canaryOrganizationCount, active: globalEnabled || canaryOrganizationCount > 0 };
}

export function expectedTwitterWorkers(environment: TwitterRolloutEnvironment) {
  const moduleEnabled = twitterRolloutScope(environment).active;
  return new Map<TwitterWorkerName, boolean>([
    ['athena-twitter-publication-worker', moduleEnabled && enabled(environment.TWITTER_PUBLICATION_WORKER_ENABLED)],
    ['athena-twitter-preparation-worker', moduleEnabled && enabled(environment.TWITTER_PREPARATION_WORKER_ENABLED)],
    ['athena-twitter-zernio-sync-worker', moduleEnabled && enabled(environment.TWITTER_SYNC_WORKER_ENABLED)],
    ['athena-twitter-analytics-worker', moduleEnabled && enabled(environment.TWITTER_ANALYTICS_ENABLED) && enabled(environment.TWITTER_ANALYTICS_WORKER_ENABLED)],
    ['athena-twitter-webhook-reconcile-worker', moduleEnabled && enabled(environment.TWITTER_RECONCILE_WORKER_ENABLED)],
    ['athena-twitter-connect-worker', moduleEnabled && enabled(environment.TWITTER_CONNECT_WORKER_ENABLED)],
    ['athena-twitter-observability-worker', moduleEnabled && enabled(environment.TWITTER_OBSERVABILITY_WORKER_ENABLED)],
    ['athena-twitter-vercel-fallback', moduleEnabled && enabled(environment.TWITTER_FALLBACK_ENABLED) && enabled(environment.TWITTER_PUBLICATION_WORKER_ENABLED)],
  ]);
}

export function summarizeTwitterWorkers(
  rows: TwitterWorkerHeartbeat[],
  environment: TwitterRolloutEnvironment,
  nowMs: number,
  staleAfterSeconds: number,
) {
  const expected = expectedTwitterWorkers(environment);
  const byName = new Map(rows.map((row) => [row.worker_name, row]));

  return TWITTER_WORKER_NAMES.map((name) => {
    const row = byName.get(name);
    const lastSeenMs = row ? Date.parse(row.last_seen_at) : Number.NaN;
    const ageSeconds = Number.isFinite(lastSeenMs) ? Math.max(0, Math.floor((nowMs - lastSeenMs) / 1_000)) : null;
    const shouldBeActive = expected.get(name) === true;
    const stale = shouldBeActive && (ageSeconds === null || ageSeconds > staleAfterSeconds);
    return {
      name,
      expectedActive: shouldBeActive,
      state: stale ? 'stale' as const : shouldBeActive ? 'active' as const : 'disabled' as const,
      mode: row?.mode ?? null,
      ageSeconds,
    };
  });
}

export function classifyTwitterRolloutHealth(input: {
  staleWorkers: number;
  openBreakers: number;
  publicationUnknown: number;
  analyticsUnknown: number;
  unknownHolds: number;
  unknownReservations: number;
  pausedQueueItems: number;
  recentRateLimits: number;
}) {
  const criticalSignals = input.staleWorkers + input.openBreakers + input.publicationUnknown + input.analyticsUnknown + input.unknownHolds + input.unknownReservations;
  const warningSignals = input.pausedQueueItems + input.recentRateLimits;
  return {
    status: criticalSignals > 0 ? 'unhealthy' as const : warningSignals > 0 ? 'degraded' as const : 'ok' as const,
    criticalSignals,
    warningSignals,
  };
}
