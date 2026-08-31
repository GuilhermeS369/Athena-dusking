import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeInstagramProfilesCursor,
  encodeInstagramProfilesCursor,
  isCalendarDay,
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
  assert.deepEqual(normalizeInstagramProfilesFilters({ query: '  @Conta  ', groupId: 'x', status: 'online', situation: 'error', publication: 'posted', sort: 'followers', createdOn: '2026-08-27' }), {
    query: '@Conta', groupId: null, status: 'online', situation: 'error', publication: 'posted', sort: 'followers', createdOn: '2026-08-27',
  });
  assert.deepEqual(normalizeInstagramProfilesFilters({ status: 'desconhecido' as never, situation: 'x' as never, sort: 'aleatorio' as never, createdOn: '27/08/2026' as never }), {
    query: '', groupId: null, status: 'all', situation: 'all', publication: 'all', sort: 'recent', createdOn: null,
  });
  assert.equal(normalizeInstagramProfilesFilters({ sort: 'views' }).sort, 'views');
});

test('data de adição só aceita dia que existe no calendário', () => {
  assert.equal(isCalendarDay('2026-08-27'), true);
  assert.equal(isCalendarDay('2024-02-29'), true);

  // O regex sozinho deixaria passar; o Postgres recusaria no meio da consulta.
  // 2026 não é bissexto, então 29/02 é tão inexistente quanto 30/02.
  assert.equal(isCalendarDay('2026-02-29'), false);
  assert.equal(isCalendarDay('2026-02-30'), false);
  assert.equal(isCalendarDay('2026-13-01'), false);

  assert.equal(isCalendarDay('27/08/2026'), false);
  assert.equal(isCalendarDay('2026-8-7'), false);
  assert.equal(isCalendarDay(''), false);
  assert.equal(isCalendarDay(null), false);
  assert.equal(isCalendarDay(20260827), false);
});

test('data inválida vira ausência de filtro em vez de erro', () => {
  assert.equal(normalizeInstagramProfilesFilters({ createdOn: '2026-02-30' }).createdOn, null);
  assert.equal(normalizeInstagramProfilesFilters({}).createdOn, null);
  assert.equal(normalizeInstagramProfilesFilters({ createdOn: '2026-08-27' }).createdOn, '2026-08-27');
});
