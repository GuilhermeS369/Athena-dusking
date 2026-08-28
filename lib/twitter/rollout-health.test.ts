import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { classifyTwitterRolloutHealth, expectedTwitterWorkers, summarizeTwitterWorkers, twitterRolloutScope } from './rollout-health.ts';

test('workers X só são esperados quando suas flags exclusivas estão habilitadas', () => {
  const disabled = expectedTwitterWorkers({});
  assert.equal([...disabled.values()].some(Boolean), false);

  const enabled = expectedTwitterWorkers({
    TWITTER_MODULE_ENABLED: 'true',
    TWITTER_PUBLICATION_WORKER_ENABLED: 'true',
    TWITTER_PREPARATION_WORKER_ENABLED: 'true',
    TWITTER_ANALYTICS_ENABLED: 'true',
    TWITTER_ANALYTICS_WORKER_ENABLED: 'true',
    TWITTER_CONNECT_WORKER_ENABLED: 'true',
  });
  assert.equal(enabled.get('athena-twitter-publication-worker'), true);
  assert.equal(enabled.get('athena-twitter-preparation-worker'), true);
  assert.equal(enabled.get('athena-twitter-analytics-worker'), true);
  assert.equal(enabled.get('athena-twitter-webhook-reconcile-worker'), false);
  assert.equal(enabled.get('athena-twitter-connect-worker'), true);
  assert.equal(enabled.get('athena-twitter-vercel-fallback'), false);
});

test('escopo operacional reconhece canário sem confundi-lo com rollout global', () => {
  assert.deepEqual(twitterRolloutScope({ TWITTER_MODULE_ENABLED: 'false', TWITTER_CANARY_ORGANIZATION_IDS: 'org-a, org-b,org-a' }), {
    globalEnabled: false,
    canaryOrganizationCount: 2,
    active: true,
  });
});

test('worker desligado não gera falso stale e worker esperado sem heartbeat gera alerta', () => {
  const now = Date.parse('2026-08-22T22:00:00Z');
  const workers = summarizeTwitterWorkers([], {
    TWITTER_MODULE_ENABLED: 'true',
    TWITTER_PUBLICATION_WORKER_ENABLED: 'true',
  }, now, 120);

  assert.equal(workers.some((worker) => worker.name.includes('generation')), false);
  assert.equal(workers.find((worker) => worker.name === 'athena-twitter-publication-worker')?.state, 'stale');
});

test('saúde do rollout separa sinais críticos de avisos', () => {
  assert.deepEqual(classifyTwitterRolloutHealth({ staleWorkers: 0, openBreakers: 0, publicationUnknown: 0, analyticsUnknown: 0, unknownHolds: 0, unknownReservations: 0, pausedQueueItems: 0, recentRateLimits: 0 }), { status: 'ok', criticalSignals: 0, warningSignals: 0 });
  assert.equal(classifyTwitterRolloutHealth({ staleWorkers: 0, openBreakers: 0, publicationUnknown: 0, analyticsUnknown: 0, unknownHolds: 0, unknownReservations: 0, pausedQueueItems: 2, recentRateLimits: 1 }).status, 'degraded');
  assert.equal(classifyTwitterRolloutHealth({ staleWorkers: 1, openBreakers: 0, publicationUnknown: 0, analyticsUnknown: 0, unknownHolds: 0, unknownReservations: 0, pausedQueueItems: 0, recentRateLimits: 0 }).status, 'unhealthy');
});

test('endpoint de saúde é read-only e isolado das tabelas operacionais Instagram', async () => {
  const source = await readFile(new URL('../../app/api/internal/twitter-rollout-health/route.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\.rpc\(|\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
  assert.doesNotMatch(source, /instagram_profiles|publication_items(?!')|worker_heartbeats(?!')/);
  assert.match(source, /twitter_publication_items/);
  assert.match(source, /twitter_wallets/);
  assert.match(source, /twitter_worker_heartbeats/);
});
