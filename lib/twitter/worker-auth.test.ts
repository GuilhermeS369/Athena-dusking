import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { isTwitterNamedWorkerAuthorized, isTwitterWorkerAuthorized } from './worker-auth.ts';

function request(secret: string) {
  return new Request('https://athena.invalid', { headers: { 'x-twitter-worker-secret': secret } });
}

function internalRequest(path: string, secret: string) {
  return new Request(`https://athena.invalid${path}`, { headers: { 'x-twitter-worker-secret': secret } });
}

test('cada worker X aceita somente o segredo do próprio papel', () => {
  const previousPublication = process.env.TWITTER_PUBLICATION_WORKER_SECRET;
  const previousAnalytics = process.env.TWITTER_ANALYTICS_WORKER_SECRET;
  process.env.TWITTER_PUBLICATION_WORKER_SECRET = 'publication-secret-test';
  process.env.TWITTER_ANALYTICS_WORKER_SECRET = 'analytics-secret-test';
  try {
    assert.equal(isTwitterWorkerAuthorized(request('publication-secret-test'), 'publication'), true);
    assert.equal(isTwitterWorkerAuthorized(request('analytics-secret-test'), 'publication'), false);
    assert.equal(isTwitterNamedWorkerAuthorized(request('analytics-secret-test'), 'athena-twitter-analytics-worker'), true);
    assert.equal(isTwitterNamedWorkerAuthorized(request('publication-secret-test'), 'athena-twitter-analytics-worker'), false);
    assert.equal(isTwitterNamedWorkerAuthorized(request('publication-secret-test'), 'worker-desconhecido'), false);
    assert.equal(isTwitterWorkerAuthorized(internalRequest('/api/internal/twitter-publication-claims', 'publication-secret-test')), true);
    assert.equal(isTwitterWorkerAuthorized(internalRequest('/api/internal/twitter-analytics-claims', 'publication-secret-test')), false);
  } finally {
    if (previousPublication === undefined) delete process.env.TWITTER_PUBLICATION_WORKER_SECRET;
    else process.env.TWITTER_PUBLICATION_WORKER_SECRET = previousPublication;
    if (previousAnalytics === undefined) delete process.env.TWITTER_ANALYTICS_WORKER_SECRET;
    else process.env.TWITTER_ANALYTICS_WORKER_SECRET = previousAnalytics;
  }
});

test('rotas internas não usam mais segredo genérico compartilhado', async () => {
  const [worker, heartbeat, breaker] = await Promise.all([
    readFile(new URL('../../scripts/workers/twitter-worker.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../../app/api/internal/twitter-heartbeat/route.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../app/api/internal/twitter-circuit-breaker/route.ts', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(`${worker}\n${heartbeat}\n${breaker}`, /TWITTER_WORKER_SECRET/);
  assert.match(heartbeat, /isTwitterNamedWorkerAuthorized/);
  assert.match(breaker, /isTwitterNamedWorkerAuthorized/);
});
