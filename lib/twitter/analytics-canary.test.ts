import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const canaryUrl = new URL('../../scripts/twitter/prepare-fanout-analytics-canary.ts', import.meta.url);
const reconciliationUrl = new URL('../../scripts/twitter/reconcile-fanout-analytics-canary.ts', import.meta.url);

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

test('reconciliação fan-out mantém hold sem delta e liquida somente unidades comprovadas', async () => {
  const source = await readFile(reconciliationUrl, 'utf8');
  assert.match(source, /audit-fanout-canary-billing/);
  assert.match(source, /settle-fanout-canary-zero-after-synced-read/);
  assert.match(source, /Metering ainda não registrou a leitura; manter hold/);
  assert.match(source, /twitter_connection_events/);
  assert.match(source, /lateUsageReconciliationRequired: true/);
  assert.match(source, /p_billed_units: billedUnits/);
  assert.match(source, /billingSource: 'GET \/v1\/usage'/);
  assert.match(source, /expectedReleasedMicros = MAXIMUM_MICROS - expectedSettledMicros/);
  assert.match(source, /expectedSettledMicros === 0 \? 'released' : 'settled'/);
  assert.doesNotMatch(source, /setAccountCapabilities/);
});
