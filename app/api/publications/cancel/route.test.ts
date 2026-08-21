import test from 'node:test';
import assert from 'node:assert/strict';

// Regressão do guard que bloqueou o cancelamento na produção: IDs de lote
// válidos devem ter formato RFC 4122 8-4-4-4-12.
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test('aceita UUID RFC 4122 de lote na requisição de cancelamento', () => {
  assert.equal(uuidPattern.test('71703a97-22b2-441a-9fc6-eb139f339d24'), true);
});

test('rejeita UUID sem o hífen antes do bloco final', () => {
  assert.equal(uuidPattern.test('71703a97-22b2-441a-9fceb139f339d24'), false);
});
