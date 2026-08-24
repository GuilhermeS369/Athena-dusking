import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('administração Zernio X tem importação pareada, saldo configurável e limite transacional', async () => {
  const [migration, client, route, provisioning] = await Promise.all([
    readFile(new URL('../../supabase/migrations/254_twitter_zernio_bulk_import_and_configurable_grants.sql', import.meta.url), 'utf8'),
    readFile(new URL('../../app/x/twitter-zernio-client.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../app/api/x/integrations/zernio/import-batches/route.ts', import.meta.url), 'utf8'),
    readFile(new URL('./zernio-connections.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(client, /Nomes das contas/);
  assert.match(client, /API keys/);
  assert.match(client, /Saldo inicial \(USD\)/);
  assert.match(client, /Limite de contas X por Zernio/);
  assert.match(client, /X \/ Twitter/);
  assert.match(client, /twitter-zernio-connection-grid/);
  assert.doesNotMatch(client, /zernio-metrics-four|Transferir identidade|twitter-zernio-transfer/);
  assert.match(client, /zernio-connection-card/);
  assert.match(route, /twitter_create_connection_import_batch/);
  assert.match(migration, /p_initial_grant_micros/);
  assert.match(migration, /twitter_reserve_oauth_attempt/);
  assert.match(migration, /api_key_fingerprint text primary key/);
  assert.match(provisioning, /twitter_api_key_registry/);
  assert.doesNotMatch(`${migration}\n${route}\n${provisioning}`, /instagram_profiles|publication_items/);
});

test('concessão configurável continua única por identidade e usa micros inteiros', async () => {
  const migration = await readFile(new URL('../../supabase/migrations/254_twitter_zernio_bulk_import_and_configurable_grants.sql', import.meta.url), 'utf8');
  assert.match(migration, /unique\s*\(identity_id\)|on conflict\(identity_id\) do nothing/i);
  assert.match(migration, /default_initial_grant_micros bigint/);
  assert.match(migration, /delta_micros[\s\S]*p_initial_grant_micros/);
  assert.doesNotMatch(migration, /double precision|real|numeric\s*\(/i);
});
