import assert from 'node:assert/strict';
import test from 'node:test';

import { isTwitterPrimaryHeartbeatFresh, twitterFallbackExecutionMode } from './fallback.ts';

test('fallback Twitter exige flags de worker e fallback e bloqueia live sem autorização adicional', () => {
  assert.equal(twitterFallbackExecutionMode({}), 'disabled');
  assert.equal(twitterFallbackExecutionMode({ TWITTER_FALLBACK_ENABLED: 'true', TWITTER_PUBLICATION_WORKER_ENABLED: 'true', TWITTER_PUBLICATION_MODE: 'shadow' }), 'shadow');
  assert.equal(twitterFallbackExecutionMode({ TWITTER_FALLBACK_ENABLED: 'true', TWITTER_PUBLICATION_WORKER_ENABLED: 'true', TWITTER_PUBLICATION_MODE: 'live' }), 'disabled');
  assert.equal(twitterFallbackExecutionMode({ TWITTER_FALLBACK_ENABLED: 'true', TWITTER_FALLBACK_LIVE_ENABLED: 'true', TWITTER_PUBLICATION_WORKER_ENABLED: 'true', TWITTER_PUBLICATION_MODE: 'live' }), 'live');
});

test('fallback só assume quando heartbeat primário está realmente expirado', () => {
  const now = Date.parse('2026-08-22T22:00:00Z');
  assert.equal(isTwitterPrimaryHeartbeatFresh({ mode: 'live', last_seen_at: '2026-08-22T21:59:01Z' }, now, 60), true);
  assert.equal(isTwitterPrimaryHeartbeatFresh({ mode: 'shadow', last_seen_at: '2026-08-22T21:58:59Z' }, now, 60), false);
  assert.equal(isTwitterPrimaryHeartbeatFresh({ mode: 'stopped', last_seen_at: '2026-08-22T21:59:59Z' }, now, 60), false);
  assert.equal(isTwitterPrimaryHeartbeatFresh(null, now, 60), false);
});
