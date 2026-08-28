import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTwitterZernioBulkRows, parseTwitterZernioTarget, resolveTwitterZernioTarget } from './zernio-bulk.ts';

const connections = [
  { id: 'a', label: 'Conta Ágata', twitter_profile_count: 1, twitter_slot_limit: 3, remote_twitter_account_count: 1, remote_inventory_checked_at: '2026-08-24T12:00:00Z', active_slot_reservation_count: 0 },
  { id: 'b', label: 'Conta Beta', twitter_profile_count: 0, twitter_slot_limit: 2, remote_twitter_account_count: 0, remote_inventory_checked_at: '2026-08-24T12:00:00Z', active_slot_reservation_count: 1 },
];

test('interpreta conta e grupo X sem normalizar o texto', () => {
  assert.deepEqual(parseTwitterZernioTarget('Conta Ágata;Equipe Norte'), { kind: 'valid', connectionName: 'Conta Ágata', groupName: 'Equipe Norte' });
  assert.equal(resolveTwitterZernioTarget(connections, [{ id: 'g', name: 'Equipe Norte' }], 'Conta Ágata;Equipe Norte').valid, true);
  assert.equal(resolveTwitterZernioTarget(connections, [{ id: 'g', name: 'Equipe Norte' }], 'conta Ágata;Equipe Norte').valid, false);
  assert.equal(parseTwitterZernioTarget('Conta Ágata;').kind, 'invalid');
});

test('gera uma linha por vaga e aceita quantidade sem teto artificial', () => {
  const plan = buildTwitterZernioBulkRows(connections, 50_000, 'Equipe Norte');
  assert.equal(plan.availableSlots, 3);
  assert.equal(plan.rows.length, 3);
  assert.deepEqual(plan.rows, ['Conta Beta;Equipe Norte', 'Conta Ágata;Equipe Norte', 'Conta Ágata;Equipe Norte']);
});

test('exclui inventário remoto sem snapshot confiável', () => {
  const plan = buildTwitterZernioBulkRows([{ ...connections[0], remote_inventory_checked_at: null }], 10, null);
  assert.equal(plan.rows.length, 0);
  assert.equal(plan.unavailableConnections, 1);
});
