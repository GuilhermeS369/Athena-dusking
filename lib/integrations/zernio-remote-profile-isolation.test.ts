import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const startRoute = readFileSync('app/api/integrations/zernio/start/route.ts', 'utf8');
const callbackRoute = readFileSync('app/api/integrations/zernio/callback/route.ts', 'utf8');
const worker = readFileSync('scripts/workers/zernio-sync-worker.mjs', 'utf8');
const migration = readFileSync('supabase/migrations/161_zernio_isolated_remote_profiles.sql', 'utf8');

test('abre OAuth diretamente em profile exclusivo sem fila pré-Instagram', () => {
  assert.match(startRoute, /claim_zernio_attempt_remote_profile/);
  assert.match(startRoute, /createProfile\(remoteProfileName, attempt\.id\)/);
  assert.match(startRoute, /startConnect\('instagram', remoteProfileId/);
  assert.doesNotMatch(startRoute, /enqueueZernioOauthTurn/);
  assert.doesNotMatch(startRoute, /\/zernio\/aguardando/);
  assert.doesNotMatch(callbackRoute, /validateZernioOauthTurn/);
});

test('worker restringe seleção e persistência ao profile exclusivo do attempt', () => {
  assert.match(worker, /zernio_connection_remote_profiles/);
  assert.match(worker, /attempt\.zernio_profile_id/);
  assert.match(worker, /accountsForCanonicalProfile\([\s\S]*attempt\.zernio_profile_id/);
  assert.match(worker, /zernio_profile_id: attempt\.zernio_profile_id/);
  assert.match(worker, /mark_zernio_attempt_remote_profile_connected/);
  assert.doesNotMatch(worker, /p_instagram_identity_id/);
  assert.doesNotMatch(worker, /p_zernio_account_id: accountId\(selectedAccount\)/);
});

test('banco mantém unicidade global de profile remoto e claim exclusivo por attempt', () => {
  assert.match(migration, /unique\(claimed_by_attempt_id\)/);
  assert.match(migration, /zernio_remote_profiles_global_owner_idx/);
  assert.match(migration, /on public\.zernio_connection_remote_profiles\(zernio_profile_id\)/);
  assert.match(migration, /remote_profile\.status in \('claimed', 'connected'\)/);
  assert.doesNotMatch(migration, /zernio_oauth_turns_one_active_connection_idx\s+on/);
});

test('vinte aparelhos podem preparar profiles distintos sem teto fixo local', () => {
  const ids = Array.from({ length: 20 }, (_, index) => `attempt-${index}`);
  const names = ids.map((id) => `Pandora organization ${id}`);
  assert.equal(new Set(names).size, 20);
  assert.doesNotMatch(startRoute, /Math\.min\(20|limit\s*=\s*20/);
});
