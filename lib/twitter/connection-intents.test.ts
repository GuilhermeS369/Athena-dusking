import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('fila OAuth X é durável, isolada e delega o caminho antigo', async () => {
  const [migration, worker, legacyRoute, callback, profilesClient] = await Promise.all([
    readFile(new URL('../../supabase/migrations/256_twitter_oauth_connection_intents.sql', import.meta.url), 'utf8'),
    readFile(new URL('../../scripts/workers/twitter-worker.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../../app/api/x/integrations/zernio/connections/[connectionId]/connect/route.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../app/api/x/integrations/zernio/connect-intents/callback/route.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../app/x/twitter-profiles-client.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(migration, /for update skip locked/i);
  assert.match(migration, /unique\(organization_id, idempotency_key\)/i);
  assert.match(migration, /greatest\(coalesce\(connection_row\.remote_twitter_account_count,0\),local_count\)/i);
  assert.match(migration, /status in \('queued','preparing','ready','callback_received','reconciling'\)/i);
  assert.match(migration, /twitter_retry_connection_intent/);
  assert.match(worker, /role==='connect'/);
  assert.match(worker, /item\.returned_account_id/);
  assert.match(worker, /account_not_propagated/);
  assert.match(legacyRoute, /enqueueTwitterConnectionIntent/);
  assert.doesNotMatch(legacyRoute, /createTwitterOAuthAttempt|startTwitterOAuth/);
  assert.match(callback, /twitter_record_connection_intent_callback/);
  assert.match(callback, /connected[\s\S]*twitter/);
  assert.match(profilesClient, /\/api\/auth\/mirror-link/);
  assert.doesNotMatch(`${migration}\n${worker}\n${legacyRoute}\n${callback}`, /instagram_profiles|instagram_connections/);
});

test('contrato não impõe teto de fila e mantém concorrência configurável', async () => {
  const [bulk, worker, route] = await Promise.all([
    import('./zernio-bulk.ts'),
    readFile(new URL('../../scripts/workers/twitter-worker.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../../app/api/x/integrations/zernio/connect-intents/route.ts', import.meta.url), 'utf8'),
  ]);
  const connection = { id: 'c', label: 'Conta X', twitter_profile_count: 0, twitter_slot_limit: 50, remote_twitter_account_count: 0, remote_inventory_checked_at: new Date().toISOString(), active_slot_reservation_count: 0 };
  for (const browsers of [10, 20, 50]) {
    const rows = await Promise.all(Array.from({ length: browsers }, async (_, index) => bulk.buildTwitterZernioBulkRows([connection], index + 1, null).rows.length));
    assert.equal(rows.at(-1), browsers);
  }
  assert.match(worker, /TWITTER_CONNECT_WORKER_CONCURRENCY/);
  assert.match(worker, /Promise\.all\(items\.slice/);
  assert.doesNotMatch(route, /max(?:imum)?Queue|queueLimit|too_many_intents/i);
});
