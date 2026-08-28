import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('conexão pela tela de perfis confirma Analytics antes de concluir o perfil X', async () => {
  const [worker, resultRoute, profilesClient] = await Promise.all([
    readFile(new URL('../../scripts/workers/twitter-worker.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../../app/api/internal/twitter-connect-results/route.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../app/x/twitter-profiles-client.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(worker, /configureAccountCapabilities\(apiKey,\[account\],true\)/);
  assert.doesNotMatch(worker, /configureAccountCapabilities\(apiKey,\[account\],false\)/);
  assert.match(resultRoute, /twitter_set_connection_capabilities/);
  assert.match(resultRoute, /p_analytics_enabled: true/);
  assert.match(resultRoute, /canFetchAnalytics: true/);
  assert.match(profilesClient, /Analytics será ativado obrigatoriamente/);
});

test('provisionamento e banco mantêm Analytics ativo para perfis X novos', async () => {
  const [provisioning, migration] = await Promise.all([
    readFile(new URL('./zernio-connections.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../supabase/migrations/262_require_analytics_for_new_twitter_profiles.sql', import.meta.url), 'utf8'),
  ]);

  assert.match(provisioning, /analytics_enabled: true/);
  assert.match(migration, /alter column analytics_enabled set default true/);
  assert.match(migration, /twitter_profiles_require_analytics/);
});

test('Analytics é controlado por perfil e não pela administração da Zernio', async () => {
  const [profilesClient, zernioClient, profileRoute, migration, analyticsService] = await Promise.all([
    readFile(new URL('../../app/x/twitter-profiles-client.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../app/x/twitter-zernio-client.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../app/api/x/profiles/[profileId]/analytics/route.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../supabase/migrations/263_twitter_profile_analytics_capability.sql', import.meta.url), 'utf8'),
    readFile(new URL('./analytics-service.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(profilesClient, /Ativar Analytics/);
  assert.match(profilesClient, /Desativar Analytics/);
  assert.match(profilesClient, /\/api\/x\/profiles\/\$\{profile\.id\}\/analytics/);
  assert.doesNotMatch(zernioClient, /Conectar conta X/);
  assert.doesNotMatch(zernioClient, /Ativar Analytics|Desligar Analytics/);
  assert.match(profileRoute, /setAccountCapabilities\(epoch\.zernio_account_id/);
  assert.match(migration, /add column if not exists analytics_enabled boolean not null default true/);
  assert.match(migration, /twitter_profiles_cancel_reserved_analytics/);
  assert.match(migration, /p\.analytics_enabled and p\.can_fetch_analytics/);
  assert.match(analyticsService, /profile\.analytics_enabled/);
});
