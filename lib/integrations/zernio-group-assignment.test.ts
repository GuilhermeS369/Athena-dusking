import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const accountsSource = readFileSync(new URL('./zernio-accounts.ts', import.meta.url), 'utf8');
const migrationSource = readFileSync(new URL('../../supabase/migrations/092_zernio_attempt_group_assignment.sql', import.meta.url), 'utf8');

test('o upsert do perfil acontece estritamente antes da associação ao grupo', () => {
  const upsertIndex = accountsSource.indexOf("admin.rpc('reconcile_zernio_connection_accounts'");
  const assignmentIndex = accountsSource.indexOf('const groupAssignment = await assignAttemptProfilesToRequestedGroup');
  assert.notEqual(upsertIndex, -1);
  assert.notEqual(assignmentIndex, -1);
  assert.ok(upsertIndex < assignmentIndex);
});

test('falha de grupo é capturada e convertida em resultado não destrutivo', () => {
  assert.match(accountsSource, /status: 'failed',[\s\S]*assignedProfileIds: \[\],[\s\S]*error: message/);
  assert.doesNotMatch(accountsSource, /delete\(\)[\s\S]*instagram_profiles/);
});

test('associação concorrente usa lock de linha e inserção idempotente', () => {
  assert.match(migrationSource, /for update/i);
  assert.match(migrationSource, /on conflict \(group_id, profile_id\) do nothing/i);
  assert.match(migrationSource, /id = any\(clean_profile_ids\)/i);
});
