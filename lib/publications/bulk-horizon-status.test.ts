import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveBulkOperationalStatus } from './bulk-horizon-status.ts';

const now = new Date('2026-08-28T06:00:00.000Z');

test('exibe horizonte abastecido quando o próximo slot ainda está fora das próximas 48 horas', () => {
  assert.deepEqual(deriveBulkOperationalStatus({
    planStatus: 'generating', intervalMinutes: 60, now,
    chunks: [{ status: 'queued', slotStart: '0', slotCount: '100', nextSlotIndex: '10', scheduleBaseAt: '2026-08-29T20:00:00.000Z' }],
  }), {
    status: 'horizon_ready', eligibleChunks: 0, nextHorizonRefreshAt: '2026-08-28T07:00:00.000Z',
  });
});

test('mantém gerando quando o próximo slot já entrou no horizonte', () => {
  const result = deriveBulkOperationalStatus({
    planStatus: 'generating', intervalMinutes: 60, now,
    chunks: [{ status: 'queued', slotStart: '0', slotCount: '100', nextSlotIndex: '10', scheduleBaseAt: '2026-08-29T18:00:00.000Z' }],
  });
  assert.equal(result.status, 'generating');
  assert.equal(result.eligibleChunks, 1);
});

test('não mascara processamento, falha ou estado terminal do plano', () => {
  const chunk = { status: 'processing', slotStart: '0', slotCount: '100', nextSlotIndex: '10', scheduleBaseAt: '2026-09-10T00:00:00.000Z' };
  assert.equal(deriveBulkOperationalStatus({ planStatus: 'generating', intervalMinutes: 60, now, chunks: [chunk] }).status, 'generating');
  assert.equal(deriveBulkOperationalStatus({ planStatus: 'paused', intervalMinutes: 60, now, chunks: [], }).status, 'paused');
});
