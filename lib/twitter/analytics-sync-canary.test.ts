import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('canário fan-out ativa sync, faz uma leitura exata e sempre desliga', async () => {
  const source = await readFile(new URL('../../scripts/twitter/resume-fanout-analytics-sync-canary.mjs', import.meta.url), 'utf8');
  assert.match(source, /publishedPosts > Number\(item\.reserved_units\)/);
  assert.match(source, /setRemoteCapabilities\(context\.apiKey, context\.accountIds, true\)/);
  assert.match(source, /finally\s*{/);
  assert.match(source, /forceDisable\(context, sourceId/);
  assert.match(source, /TWITTER_ANALYTICS_SYNC_CANARY_MODE: 'watchdog'/);
  assert.match(source, /triggerSinglePostRead\(context\)/);
  assert.equal(source.match(/\/v1\/analytics\?postId=/g)?.length, 1);
  assert.match(source, /firstFinal = await usage/);
  assert.match(source, /secondFinal = await usage/);
  assert.match(source, /delta <= Number\(context\.item\.reserved_units\)/);
  assert.doesNotMatch(source, /twitter_create_wallet_reservation|twitter_settle_wallet_reservation|twitter_release_wallet_reservation/);
  assert.doesNotMatch(source, /inbox:\s*true/);
});
