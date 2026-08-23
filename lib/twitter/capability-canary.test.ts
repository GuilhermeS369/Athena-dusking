import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('canário de capability reserva antes de ativar e sempre desliga em finally', async () => {
  const source = await readFile(new URL('../../scripts/twitter/run-zernio-capability-canary.mjs', import.meta.url), 'utf8');
  assert.ok(source.indexOf("twitter_create_wallet_reservation") < source.indexOf("recordCapabilities(context.connection.id, membership.user_id, true"));
  assert.match(source, /finally \{/);
  assert.match(source, /setRemoteCapabilities\(context\.apiKey, context\.accountIds, false\)/);
  assert.match(source, /twitter_mark_reservation_outcome_unknown/);
  assert.match(source, /spawn\(process\.execPath/);
  assert.match(source, /windowsHide: true/);
  assert.match(source, /TWITTER_CAPABILITY_WATCHDOG_DELAY_SECONDS/);
  assert.match(source, /TWITTER_CAPABILITY_RESERVATION_ID/);
  assert.match(source, /capability-watchdog-unknown/);
  assert.match(source, /durationSeconds \+ \(settleDelaySeconds \* 2\) \+ 60/);
});

test('canário mantém Inbox desligado e liquida somente delta comprovado de posts_read', async () => {
  const source = await readFile(new URL('../../scripts/twitter/run-zernio-capability-canary.mjs', import.meta.url), 'utf8');
  assert.match(source, /xCapabilities: \{ analytics, inbox: false \}/);
  assert.match(source, /operations\.posts_read/);
  assert.match(source, /const settledMicros = delta \* 5_000/);
  assert.match(source, /delta <= coverageReads/);
  assert.match(source, /firstFinalUsage\.postsRead !== secondFinalUsage\.postsRead/);
  assert.match(source, /5_000_000/);
  assert.match(source, /twitter_provider_usage_reconciliations/);
  assert.match(source, /baseline posts_read ainda não está reconciliado/);
  assert.match(source, /posted_balance_micros\) - 5_000_000/);
});
