import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeInstagramProfilesCursor,
  encodeInstagramProfilesCursor,
  normalizeInstagramProfilesFilters,
  normalizeInstagramProfilesLimit,
} from './catalog.ts';

test('cursor do catálogo de perfis faz round-trip e rejeita valores inválidos', () => {
  const cursor = { createdAt: '2026-08-27T12:00:00.000Z', id: '550e8400-e29b-41d4-a716-446655440000' };
  assert.deepEqual(decodeInstagramProfilesCursor(encodeInstagramProfilesCursor(cursor)), cursor);
  assert.equal(decodeInstagramProfilesCursor('inválido'), null);
  assert.equal(decodeInstagramProfilesCursor(Buffer.from(JSON.stringify({ createdAt: 'hoje', id: 'x' })).toString('base64url')), null);
});

test('limite do catálogo fica entre 1 e 100', () => {
  assert.equal(normalizeInstagramProfilesLimit(0), 1);
  assert.equal(normalizeInstagramProfilesLimit(40), 40);
  assert.equal(normalizeInstagramProfilesLimit(500), 100);
  assert.equal(normalizeInstagramProfilesLimit(Number.NaN), 40);
});

test('filtros do catálogo são normalizados e valores desconhecidos voltam ao padrão', () => {
  assert.deepEqual(normalizeInstagramProfilesFilters({ query: '  @Conta  ', groupId: 'x', status: 'online', situation: 'error', publication: 'posted' }), {
    query: '@Conta', groupId: null, status: 'online', situation: 'error', publication: 'posted',
  });
  assert.deepEqual(normalizeInstagramProfilesFilters({ status: 'desconhecido' as never, situation: 'x' as never }), {
    query: '', groupId: null, status: 'all', situation: 'all', publication: 'all',
  });
});
