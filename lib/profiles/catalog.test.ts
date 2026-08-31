import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeInstagramProfilesCursor,
  encodeInstagramProfilesCursor,
  normalizeInstagramProfilesFilters,
  normalizeInstagramProfilesLimit,
} from './catalog.ts';

test('cursor do catálogo de perfis faz round-trip e rejeita valores inválidos', () => {
  const cursor = { createdAt: '2026-08-27T12:00:00.000Z', id: '550e8400-e29b-41d4-a716-446655440000', metric: 0 };
  assert.deepEqual(decodeInstagramProfilesCursor(encodeInstagramProfilesCursor(cursor)), cursor);
  assert.equal(decodeInstagramProfilesCursor('inválido'), null);
  assert.equal(decodeInstagramProfilesCursor(Buffer.from(JSON.stringify({ createdAt: 'hoje', id: 'x' })).toString('base64url')), null);
});

test('cursor guarda a métrica da ordenação e tolera cursores antigos sem ela', () => {
  const cursor = { createdAt: '2026-08-27T12:00:00.000Z', id: '550e8400-e29b-41d4-a716-446655440000', metric: 918_233 };
  assert.deepEqual(decodeInstagramProfilesCursor(encodeInstagramProfilesCursor(cursor)), cursor);

  // Cursores emitidos antes da ordenação por métrica não trazem `metric`; eram
  // sempre do modo 'recent', onde a chave vale 0.
  const legacy = Buffer.from(JSON.stringify({ createdAt: cursor.createdAt, id: cursor.id })).toString('base64url');
  assert.deepEqual(decodeInstagramProfilesCursor(legacy), { ...cursor, metric: 0 });

  const negative = Buffer.from(JSON.stringify({ ...cursor, metric: -5 })).toString('base64url');
  assert.equal(decodeInstagramProfilesCursor(negative)?.metric, 0);
});

test('limite do catálogo fica entre 1 e 100', () => {
  assert.equal(normalizeInstagramProfilesLimit(0), 1);
  assert.equal(normalizeInstagramProfilesLimit(40), 40);
  assert.equal(normalizeInstagramProfilesLimit(500), 100);
  assert.equal(normalizeInstagramProfilesLimit(Number.NaN), 40);
});

test('filtros do catálogo são normalizados e valores desconhecidos voltam ao padrão', () => {
  assert.deepEqual(normalizeInstagramProfilesFilters({ query: '  @Conta  ', groupId: 'x', status: 'online', situation: 'error', publication: 'posted', sort: 'followers', created: { from: '2026-08-26', to: '2026-08-27' } }), {
    query: '@Conta', groupId: null, status: 'online', situation: 'error', publication: 'posted', sort: 'followers',
    created: { from: '2026-08-26', to: '2026-08-27' },
  });
  assert.deepEqual(normalizeInstagramProfilesFilters({ status: 'desconhecido' as never, situation: 'x' as never, sort: 'aleatorio' as never, created: { from: '27/08/2026', to: null } }), {
    query: '', groupId: null, status: 'all', situation: 'all', publication: 'all', sort: 'recent',
    created: { from: null, to: null },
  });
  assert.equal(normalizeInstagramProfilesFilters({ sort: 'views' }).sort, 'views');
});

test('intervalo inválido vira ausência de filtro em vez de erro', () => {
  assert.deepEqual(normalizeInstagramProfilesFilters({ created: { from: '2026-02-30', to: null } }).created, { from: null, to: null });
  assert.deepEqual(normalizeInstagramProfilesFilters({}).created, { from: null, to: null });
  assert.deepEqual(normalizeInstagramProfilesFilters({ created: { from: '2026-08-27', to: '2026-08-27' } }).created, { from: '2026-08-27', to: '2026-08-27' });

  // Pontas invertidas se ordenam em vez de virarem um filtro que nao casa nada.
  assert.deepEqual(normalizeInstagramProfilesFilters({ created: { from: '2026-08-29', to: '2026-08-26' } }).created, { from: '2026-08-26', to: '2026-08-29' });
});
