import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const canaryUrl = new URL('../../scripts/twitter/prepare-fanout-analytics-canary.ts', import.meta.url);

test('canário fan-out exige auditoria, recurso inédito e baseline explícito antes de reservar', async () => {
  const source = await readFile(canaryUrl, 'utf8');
  assert.match(source, /audit-fanout-post-read/);
  assert.match(source, /reserve-fanout-post-read/);
  assert.match(source, /historicalPublicationIds/);
  assert.match(source, /TWITTER_CANARY_EXPECTED_POSTS_READ/);
  assert.ok(source.indexOf('getUsageSnapshot()') < source.indexOf('const confirmed = await confirmTwitterAnalyticsQuote'));
});

test('canário fan-out valida nove unidades e nunca ativa capability ou worker', async () => {
  const source = await readFile(canaryUrl, 'utf8');
  assert.match(source, /POST_READ_RESERVE_UNITS = 9/);
  assert.match(source, /POST_READ_MAXIMUM_MICROS/);
  assert.match(source, /billing_contract_version\) === 2/);
  assert.doesNotMatch(source, /setAccountCapabilities/);
  assert.doesNotMatch(source, /twitter-heartbeat/);
  assert.doesNotMatch(source, /twitter-analytics-claims/);
});
