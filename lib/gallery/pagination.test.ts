import assert from 'node:assert/strict';
import test from 'node:test';

import { galleryPageState } from './pagination.ts';

test('mantém o botão de próxima página para 78 resultados com 30 carregados', () => {
  assert.deepEqual(galleryPageState({ displayed: 30, total: 78, hasMore: true, nextCursor: 'cursor-30' }), {
    displayed: 30,
    total: 78,
    remaining: 48,
    canLoadMore: true,
    reachedEnd: false,
  });
});

test('informa fim para uma página completa de exatamente 30 resultados', () => {
  assert.deepEqual(galleryPageState({ displayed: 30, total: 30, hasMore: false, nextCursor: null }), {
    displayed: 30,
    total: 30,
    remaining: 0,
    canLoadMore: false,
    reachedEnd: true,
  });
});

test('não apresenta botão quando a API sinaliza mais itens sem cursor utilizável', () => {
  assert.equal(galleryPageState({ displayed: 30, total: 31, hasMore: true, nextCursor: null }).canLoadMore, false);
});

test('calcula restantes para a biblioteca de postagem', () => {
  const state = galleryPageState({ displayed: 30, total: 106, hasMore: true, nextCursor: 'cursor-106' });
  assert.equal(state.remaining, 76);
  assert.equal(state.canLoadMore, true);
});
