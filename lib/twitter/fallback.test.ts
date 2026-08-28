import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

test('rota fallback usa claim V2 cercado e não depende de loop HTTP pelo domínio protegido', async () => {
  const source = await readFile(new URL('../../app/api/internal/twitter-fallback-dispatch/route.ts', import.meta.url), 'utf8');
  assert.match(source, /twitter_claim_publication_items/);
  assert.match(source, /twitter_preview_publication_candidates_v2/);
  assert.doesNotMatch(source, /twitter_complete_shadow_attempt/);
  assert.match(source, /twitter_resolve_publication_attempt/);
  assert.match(source, /twitter_acquire_dispatch_fence/);
  assert.match(source, /twitter_start_external_attempt_v2/);
  assert.match(source, /twitter_expire_dispatch_deadlines/);
  assert.match(source, /normalizeTwitterProviderResponseBody/);
  assert.doesNotMatch(source, /fetch\(new URL\(['"]\/api\/internal/);
  assert.doesNotMatch(source, /instagram_profiles|public\.publication_items/);
});
