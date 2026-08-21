import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBulkZernioRows, parseZernioBulkTarget, resolveZernioBulkTarget } from './zernio-bulk.ts';

const connections = [
  { id: 'connection-1', label: 'Conta Ágata', instagram_profile_count: 0, instagram_slot_limit: 2, remote_instagram_account_count: 0, remote_inventory_checked_at: '2026-08-16T02:00:00.000Z', remote_inventory_error_code: null, active_slot_reservation_count: 0 },
  { id: 'connection-2', label: 'Conta Beta', instagram_profile_count: 1, instagram_slot_limit: 2, remote_instagram_account_count: 1, remote_inventory_checked_at: '2026-08-16T02:00:00.000Z', remote_inventory_error_code: null, active_slot_reservation_count: 0 },
];

const now = Date.parse('2026-08-16T02:10:00.000Z');

const groups = [
  { id: 'group-1', name: 'Grupo São Paulo' },
  { id: 'group-2', name: 'Sem Acento' },
];

test('aceita conta isolada para manter conexão sem grupo', () => {
  assert.deepEqual(parseZernioBulkTarget('Conta Ágata'), {
    kind: 'valid',
    accountName: 'Conta Ágata',
    groupName: null,
  });
  const resolved = resolveZernioBulkTarget(connections, groups, 'Conta Ágata');
  assert.equal(resolved.valid, true);
  assert.equal(resolved.connection?.id, 'connection-1');
  assert.equal(resolved.groupStatus, 'not_requested');
});

test('aceita conta e grupo separados por um único ponto e vírgula', () => {
  const resolved = resolveZernioBulkTarget(connections, groups, 'Conta Ágata;Grupo São Paulo');
  assert.equal(resolved.valid, true);
  assert.equal(resolved.connection?.id, 'connection-1');
  assert.equal(resolved.group?.id, 'group-1');
});

test('correspondência é exata e preserva caixa, acentos e espaços', () => {
  assert.equal(resolveZernioBulkTarget(connections, groups, 'conta Ágata;Grupo São Paulo').valid, false);
  assert.equal(resolveZernioBulkTarget(connections, groups, 'Conta Agata;Grupo São Paulo').valid, false);
  assert.equal(resolveZernioBulkTarget(connections, groups, 'Conta Ágata;Grupo  São Paulo').valid, false);
  assert.equal(resolveZernioBulkTarget(connections, groups, 'Conta Ágata;grupo São Paulo').valid, false);
});

test('rejeita partes vazias e separadores extras', () => {
  assert.equal(parseZernioBulkTarget(';Grupo São Paulo').kind, 'invalid_format');
  assert.equal(parseZernioBulkTarget('Conta Ágata;').kind, 'invalid_format');
  assert.equal(parseZernioBulkTarget('Conta Ágata;Grupo São Paulo;extra').kind, 'invalid_format');
});

test('detecta nomes duplicados para evitar destino ambíguo', () => {
  const resolved = resolveZernioBulkTarget(
    [...connections, { id: 'connection-3', label: 'Conta Ágata', instagram_profile_count: 0, instagram_slot_limit: 2, remote_instagram_account_count: 0, remote_inventory_checked_at: '2026-08-16T02:00:00.000Z', remote_inventory_error_code: null, active_slot_reservation_count: 0 }],
    [...groups, { id: 'group-3', name: 'Grupo São Paulo' }],
    'Conta Ágata;Grupo São Paulo',
  );
  assert.equal(resolved.connectionStatus, 'duplicate');
  assert.equal(resolved.groupStatus, 'duplicate');
  assert.equal(resolved.valid, false);
});

test('Bulk Zernio gera conta sem grupo ou conta;grupo mantendo slots', () => {
  assert.deepEqual(buildBulkZernioRows(connections, 3, null, now).rows, [
    'Conta Ágata',
    'Conta Ágata',
    'Conta Beta',
  ]);
  assert.deepEqual(buildBulkZernioRows(connections, 3, 'Grupo São Paulo', now).rows, [
    'Conta Ágata;Grupo São Paulo',
    'Conta Ágata;Grupo São Paulo',
    'Conta Beta;Grupo São Paulo',
  ]);
});

test('Bulk respeita limite individual, remoto, vínculo local e reservas', () => {
  const plan = buildBulkZernioRows([
    { ...connections[0], instagram_slot_limit: 4, remote_instagram_account_count: 1, instagram_profile_count: 2, active_slot_reservation_count: 1 },
    { ...connections[1], instagram_slot_limit: 1, remote_instagram_account_count: 0, instagram_profile_count: 0 },
  ], 10, null, now);

  assert.equal(plan.availableSlots, 2);
  assert.deepEqual(plan.rows, ['Conta Beta', 'Conta Ágata']);
});

test('Bulk mantém snapshot remoto válido sem expiração fixa de 30 minutos', () => {
  const plan = buildBulkZernioRows([
    { ...connections[0], remote_inventory_checked_at: '2026-08-16T01:00:00.000Z' },
  ], 10, null, now);

  assert.equal(plan.availableSlots, 2);
  assert.equal(plan.unavailableSnapshotConnections, 0);
  assert.deepEqual(plan.rows, ['Conta Ágata', 'Conta Ágata']);
});

test('Bulk não oferece conexão sem snapshot remoto ou com erro de leitura', () => {
  const plan = buildBulkZernioRows([
    { ...connections[0], remote_inventory_checked_at: null },
    { ...connections[1], remote_inventory_error_code: 'provider_timeout' },
  ], 10, null, now);

  assert.equal(plan.availableSlots, 0);
  assert.equal(plan.unavailableSnapshotConnections, 2);
  assert.deepEqual(plan.rows, []);
});
