import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('fila de sync possui lease, claim token, idempotência e isolamento', async () => {
  const migration = await readFile(
    new URL(
      '../../supabase/migrations/242_twitter_sync_job_queue.sql',
      import.meta.url,
    ),
    'utf8',
  );

  assert.match(migration, /create table public\.twitter_sync_jobs/);
  assert.match(migration, /twitter_sync_jobs_one_active_connection_idx/);
  assert.match(migration, /twitter_enqueue_sync_job/);
  assert.match(migration, /twitter_claim_sync_jobs/);
  assert.match(migration, /lease_until/);
  assert.match(migration, /claim_token/);
  assert.match(migration, /for update of job skip locked/);
  assert.match(migration, /twitter_complete_sync_job/);
  assert.doesNotMatch(migration, /instagram_profiles|public\.publication_items/);
});

test('resultado limita inventário e nunca persiste a API key no payload', async () => {
  const source = await readFile(
    new URL('../../app/api/internal/twitter-sync-results/route.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /body\.accounts\.length > 500/);
  assert.match(source, /applyTwitterProfileInventory/);
  assert.doesNotMatch(source, /encrypted_api_key|apiKey|authorization/i);
});
