import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('ajuste administrativo X é atômico, idempotente e auditável', async () => {
  const migration = await readFile(new URL('../../supabase/migrations/255_twitter_audited_wallet_balance_adjustment.sql', import.meta.url), 'utf8');
  assert.match(migration, /for update/);
  assert.match(migration, /p_expected_posted_micros/);
  assert.match(migration, /idempotency_key = trim\(p_idempotency_key\)/);
  assert.match(migration, /insert into public\.twitter_wallet_ledger/);
  assert.match(migration, /entry_kind[\s\S]*credit/);
  assert.match(migration, /version = version \+ 1/);
  assert.match(migration, /coalesce\(auth\.role\(\), ''\) <> 'service_role'/);
  assert.doesNotMatch(migration, /instagram_profiles|publication_items/);
});
