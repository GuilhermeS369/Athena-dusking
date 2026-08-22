export type TwitterFallbackEnvironment = {
  TWITTER_FALLBACK_ENABLED?: string;
  TWITTER_FALLBACK_LIVE_ENABLED?: string;
  TWITTER_PUBLICATION_WORKER_ENABLED?: string;
  TWITTER_PUBLICATION_MODE?: string;
};

export type TwitterPublicationHeartbeat = {
  mode: string;
  last_seen_at: string;
};

function enabled(value: string | undefined) {
  return value?.trim().toLowerCase() === 'true';
}

export function twitterFallbackExecutionMode(environment: TwitterFallbackEnvironment) {
  if (!enabled(environment.TWITTER_FALLBACK_ENABLED) || !enabled(environment.TWITTER_PUBLICATION_WORKER_ENABLED)) return 'disabled' as const;
  if (environment.TWITTER_PUBLICATION_MODE === 'live') return enabled(environment.TWITTER_FALLBACK_LIVE_ENABLED) ? 'live' as const : 'disabled' as const;
  return 'shadow' as const;
}

export function isTwitterPrimaryHeartbeatFresh(heartbeat: TwitterPublicationHeartbeat | null, nowMs: number, staleAfterSeconds: number) {
  if (!heartbeat || !['shadow', 'live'].includes(heartbeat.mode)) return false;
  const lastSeenAt = new Date(heartbeat.last_seen_at).getTime();
  return Number.isFinite(lastSeenAt) && nowMs - lastSeenAt <= staleAfterSeconds * 1_000;
}
