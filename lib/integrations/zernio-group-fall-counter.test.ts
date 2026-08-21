import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync('supabase/migrations/203_zernio_group_profile_fall_counter.sql', 'utf8');
const groupsPage = readFileSync('app/(painel)/grupos/page.tsx', 'utf8');
const groupsClient = readFileSync('app/grupos/groups-client.tsx', 'utf8');
const groupsCss = readFileSync('app/grupos/groups.module.css', 'utf8');

test('captura somente quedas terminais Zernio durante remoção automática pelo worker', () => {
  assert.match(migration, /auth\.role\(\)[\s\S]*service_role/);
  assert.match(migration, /incident\.signal in \('account_disconnected', 'auth_expired'\)/);
  assert.match(migration, /incident\.state = 'remote_removal_pending'/);
  assert.doesNotMatch(migration, /duplicate_identity_auto_removed/);
});

test('contador só é finalizado após sucesso remoto ou 404 idempotente', () => {
  assert.match(migration, /new\.state = 'completed'/);
  assert.match(migration, /new\.remote_result in \('remote_deleted', 'already_disconnected_404'\)/);
  assert.match(migration, /event\.counted_at is null/);
  assert.match(migration, /unique \(incident_id, removal_sequence\)/);
});

test('página de grupos carrega a projeção agregada por organização', () => {
  assert.match(groupsPage, /from\('zernio_group_profile_removal_counts'\)/);
  assert.match(groupsPage, /select\('group_id, fallen_profile_count'\)/);
  assert.match(groupsPage, /fallenCounts=\{fallenCountsResult\.data \?\? \[\]\}/);
});

test('card mostra contador de quedas à esquerda do contador de perfis com estilo vermelho', () => {
  const fallenPosition = groupsClient.indexOf('styles.fallenCount');
  const memberPosition = groupsClient.indexOf('styles.memberCount', fallenPosition);
  assert.ok(fallenPosition >= 0 && memberPosition > fallenPosition);
  assert.match(groupsClient, /fallenCountByGroup\.get\(group\.id\) \?\? 0/);
  assert.match(groupsCss, /\.fallenCount[\s\S]*#ff9caf/);
});
