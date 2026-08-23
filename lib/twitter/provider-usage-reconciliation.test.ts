import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('reconciliação tardia cria evidência imutável, ledger e débito atômico', async () => {
  const migration = await readFile(new URL('../../supabase/migrations/245_twitter_provider_usage_reconciliation.sql', import.meta.url), 'utf8');
  assert.match(migration, /twitter_provider_usage_reconciliations_immutable/);
  assert.match(migration, /prevent_twitter_immutable_mutation/);
  assert.match(migration, /idempotency_key text not null unique/);
  assert.match(migration, /insert into public\.twitter_wallet_ledger/);
  assert.match(migration, /posted_balance_micros = posted_balance_micros - amount/);
  assert.match(migration, /origin,[\s\S]*'administration'/);
  assert.doesNotMatch(migration, /instagram_profiles|public\.publication_items/);
});

test('executor exige billing exato, capabilities off e replay idempotente', async () => {
  const source = await readFile(new URL('../../scripts/twitter/reconcile-delayed-provider-reads.ts', import.meta.url), 'utf8');
  assert.match(source, /reconcile-delayed-posts-read-27/);
  assert.match(source, /operations\.posts_read/);
  assert.match(source, /xSpendCents/);
  assert.match(source, /connection\.analytics_enabled \|\| connection\.inbox_enabled/);
  assert.match(source, /twitter_provider_usage_reconciliations/);
  assert.match(source, /relatedHttp202AttemptCount: 3/);
  assert.doesNotMatch(source, /\/analytics|\/posts\//);
});

