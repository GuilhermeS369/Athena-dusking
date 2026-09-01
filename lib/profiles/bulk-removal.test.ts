import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EMPTY_PROFILE_SELECTION,
  MAX_FILTER_PROFILE_DELETE,
  buildBulkDeleteRequest,
  clearProfileSelection,
  describeRemovalResult,
  isBulkDeleteConfirmed,
  isProfileSelected,
  profileSelectionCount,
  selectAllMatchingFilter,
  summarizeRemovalRows,
  toggleProfileSelection,
  toggleVisibleProfiles,
  visibleSelectionState,
  EMPTY_REMOVAL_TOTALS,
  MAX_PROFILES_PER_REMOVAL_CALL,
  REMOVAL_ITEM_BUDGET_PER_CALL,
  accumulateRemovalTotals,
  chunkProfileIdsForRemoval,
  profileRemovalChunkSize,
  type ProfileRemovalRow,
} from './bulk-removal.ts';

test('seleção explícita alterna sem duplicar ids', () => {
  let state = toggleProfileSelection(EMPTY_PROFILE_SELECTION, 'a', true);
  state = toggleProfileSelection(state, 'a', true);
  state = toggleProfileSelection(state, 'b', true);
  assert.deepEqual(state.selectedIds, ['a', 'b']);
  state = toggleProfileSelection(state, 'a', false);
  assert.deepEqual(state.selectedIds, ['b']);
  assert.equal(profileSelectionCount(state, 999), 1);
});

test('modo filtro conta pelo total do servidor menos as exceções', () => {
  let state = selectAllMatchingFilter();
  assert.equal(profileSelectionCount(state, 1834), 1834);
  assert.equal(isProfileSelected(state, 'qualquer-um'), true);

  state = toggleProfileSelection(state, 'a', false);
  state = toggleProfileSelection(state, 'b', false);
  assert.equal(profileSelectionCount(state, 1834), 1832);
  assert.equal(isProfileSelected(state, 'a'), false);
  assert.equal(isProfileSelected(state, 'c'), true);

  // Remarcar uma exceção devolve o perfil ao conjunto.
  state = toggleProfileSelection(state, 'a', true);
  assert.equal(profileSelectionCount(state, 1834), 1833);
});

test('contagem do modo filtro nunca fica negativa', () => {
  // filteredTotal e as exceções são observados em instantes diferentes: um perfil
  // pode sumir do filtro entre a listagem e a desmarcação.
  let state = selectAllMatchingFilter();
  state = toggleProfileSelection(state, 'a', false);
  state = toggleProfileSelection(state, 'b', false);
  assert.equal(profileSelectionCount(state, 1), 0);
});

test('marcar os visíveis preserva a seleção das outras páginas', () => {
  let state = toggleProfileSelection(EMPTY_PROFILE_SELECTION, 'pagina-1-a', true);
  state = toggleVisibleProfiles(state, ['pagina-2-a', 'pagina-2-b'], true);
  assert.deepEqual(state.selectedIds, ['pagina-1-a', 'pagina-2-a', 'pagina-2-b']);

  state = toggleVisibleProfiles(state, ['pagina-2-a', 'pagina-2-b'], false);
  assert.deepEqual(state.selectedIds, ['pagina-1-a']);
});

test('desmarcar os visíveis no modo filtro vira exceção, não limpa tudo', () => {
  const state = toggleVisibleProfiles(selectAllMatchingFilter(), ['a', 'b'], false);
  assert.equal(state.allFilterSelected, true);
  assert.deepEqual(state.excludedIds, ['a', 'b']);
  assert.equal(profileSelectionCount(state, 100), 98);
});

test('estado do checkbox dos visíveis distingue parcial de completo', () => {
  const state = toggleProfileSelection(EMPTY_PROFILE_SELECTION, 'a', true);
  assert.deepEqual(visibleSelectionState(state, ['a', 'b']), { allSelected: false, someSelected: true });
  assert.deepEqual(visibleSelectionState(toggleProfileSelection(state, 'b', true), ['a', 'b']), { allSelected: true, someSelected: false });
  assert.deepEqual(visibleSelectionState(EMPTY_PROFILE_SELECTION, []), { allSelected: false, someSelected: false });
});

test('confirmação exige exatamente EXCLUIR, tolerando espaço e caixa', () => {
  assert.equal(isBulkDeleteConfirmed('EXCLUIR'), true);
  assert.equal(isBulkDeleteConfirmed('  excluir '), true);
  assert.equal(isBulkDeleteConfirmed('EXCLUIR TUDO'), false);
  assert.equal(isBulkDeleteConfirmed(''), false);
});

test('o payload do modo filtro não carrega ids, só o filtro e as exceções', () => {
  const filters = { query: 'lulu', groupId: null, status: 'all' as const, situation: 'all' as const, publication: 'all' as const, sort: 'followers' as const };
  const explicit = buildBulkDeleteRequest(toggleProfileSelection(EMPTY_PROFILE_SELECTION, 'a', true), filters, { confirmation: 'EXCLUIR' });
  assert.deepEqual(explicit, { profileIds: ['a'], confirmation: 'EXCLUIR' });

  const byFilter = buildBulkDeleteRequest(toggleProfileSelection(selectAllMatchingFilter(), 'z', false), filters, { dryRun: true });
  assert.deepEqual(byFilter, { selectAllMatching: true, filters, excludedIds: ['z'], dryRun: true });
  assert.equal('profileIds' in byFilter, false);
});

test('limpar a seleção volta ao estado vazio', () => {
  assert.deepEqual(clearProfileSelection(), EMPTY_PROFILE_SELECTION);
  assert.equal(profileSelectionCount(clearProfileSelection(), 500), 0);
});

test('só perfis sem contrapartida remota saem da tela na hora', () => {
  const rows: ProfileRemovalRow[] = [
    { removed_profile_id: 'zernio-1', removed_username: 'a', removed_outcome: 'queued' },
    { removed_profile_id: 'zernio-2', removed_username: 'b', removed_outcome: 'already_queued' },
    { removed_profile_id: 'meta-1', removed_username: 'c', removed_outcome: 'deleted_local' },
    { removed_profile_id: 'sumiu', removed_username: null, removed_outcome: 'skipped_not_found' },
  ];
  const summary = summarizeRemovalRows(rows);
  assert.deepEqual(summary, {
    queued: 1,
    alreadyQueued: 1,
    deletedLocal: 1,
    skipped: 1,
    removedNowIds: ['meta-1'],
  });
  assert.match(describeRemovalResult(summary), /1 perfil\(is\) na fila de remoção da Zernio/);
  assert.equal(describeRemovalResult(summarizeRemovalRows([])), 'Nenhum perfil foi alterado.');
});

test('o teto do modo filtro fica abaixo do corte do PostgREST', () => {
  assert.ok(MAX_FILTER_PROFILE_DELETE < 5000);
});

test('a fatia do enfileiramento é medida em itens de fila, não em perfis', () => {
  // O caso real que motivou o fatiamento: 12 perfis com 1.111 itens abertos
  // somados iam numa transação só e estouravam o statement_timeout do papel.
  const size = profileRemovalChunkSize(12, 1111);
  assert.ok(size >= 1 && size < 12, `esperava fatiar 12 perfis, veio ${size}`);
  assert.ok(size * Math.ceil(1111 / 12) <= REMOVAL_ITEM_BUDGET_PER_CALL);

  // Perfis sem fila nenhuma não precisam de fatia pequena, mas continuam com teto.
  assert.equal(profileRemovalChunkSize(500, 0), MAX_PROFILES_PER_REMOVAL_CALL);

  // Um perfil sozinho nunca vira fatia menor que ele mesmo, por mais pesado que seja.
  assert.equal(profileRemovalChunkSize(1, 999999), 1);
  assert.equal(profileRemovalChunkSize(3, 999999), 1);
});

test('o fatiamento cobre todos os ids uma vez só, na ordem', () => {
  const ids = Array.from({ length: 10 }, (_, index) => `p${index}`);
  const chunks = chunkProfileIdsForRemoval(ids, 4);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [4, 4, 2]);
  assert.deepEqual(chunks.flat(), ids);
  // Tamanho inválido não pode virar laço infinito nem fatia vazia.
  assert.deepEqual(chunkProfileIdsForRemoval(ids, 0).flat(), ids);
  assert.deepEqual(chunkProfileIdsForRemoval([], 4), []);
});

test('continuações somam os totais em vez de sobrescrever', () => {
  const primeira = accumulateRemovalTotals(EMPTY_REMOVAL_TOTALS, {
    queued: 4, deletedLocal: 1, removedNowIds: ['meta-1'],
  });
  const segunda = accumulateRemovalTotals(primeira, {
    queued: 3, alreadyQueued: 1, skipped: 2, removedNowIds: ['meta-2'],
  });
  assert.deepEqual(segunda, {
    queued: 7,
    alreadyQueued: 1,
    deletedLocal: 1,
    skipped: 2,
    removedNowIds: ['meta-1', 'meta-2'],
  });
  // O acumulador não muda o objeto que recebeu.
  assert.equal(primeira.queued, 4);
});
