import assert from 'node:assert/strict';
import test from 'node:test';

import { formatDateTimeInSaoPaulo } from './sao-paulo.ts';

test('converte timestamp UTC para o horário de São Paulo', () => {
  assert.equal(formatDateTimeInSaoPaulo('2026-08-15T22:04:00.000Z'), '15/08/2026, 19:04');
});

test('mantém marcador para timestamp ausente', () => {
  assert.equal(formatDateTimeInSaoPaulo(null), '—');
});
