import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveBulkOperationalStatus } from './bulk-operational-status.ts';

// Substitui bulk-horizon-status.test.ts. Os dois primeiros testes de lá cobriam
// o status sintético `horizon_ready`, que deixou de existir com a migration 328:
// não há mais janela de 48h, então um plano em geração é simplesmente "gerando"
// até acabar, independentemente de quão longe no futuro está o próximo horário.

test('conta como elegível o chunk que ainda tem slots a materializar, por mais distante que seja', () => {
  const result = deriveBulkOperationalStatus({
    planStatus: 'generating',
    chunks: [{ status: 'queued', slotStart: '0', slotCount: '100', nextSlotIndex: '10' }],
  });
  assert.equal(result.status, 'generating');
  assert.equal(result.eligibleChunks, 1);
});

test('não conta chunk já esgotado, com retry exaurido ou em estado terminal', () => {
  const result = deriveBulkOperationalStatus({
    planStatus: 'generating',
    chunks: [
      { status: 'queued', slotStart: '0', slotCount: '100', nextSlotIndex: '100' },
      { status: 'failed', slotStart: '0', slotCount: '100', nextSlotIndex: '10', retryExhaustedAt: '2026-08-29T06:00:00.000Z' },
      { status: 'completed', slotStart: '0', slotCount: '100', nextSlotIndex: '100' },
      { status: 'cancelled', slotStart: '0', slotCount: '100', nextSlotIndex: '10' },
    ],
  });
  assert.equal(result.eligibleChunks, 0);
});

test('não mascara processamento nem estado terminal do plano', () => {
  const chunk = { status: 'processing', slotStart: '0', slotCount: '100', nextSlotIndex: '10' };
  assert.equal(deriveBulkOperationalStatus({ planStatus: 'generating', chunks: [chunk] }).status, 'generating');
  assert.equal(deriveBulkOperationalStatus({ planStatus: 'paused', chunks: [] }).status, 'paused');
  assert.equal(deriveBulkOperationalStatus({ planStatus: 'completed', chunks: [chunk] }).eligibleChunks, 0);
});
