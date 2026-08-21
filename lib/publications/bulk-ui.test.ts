import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BULK_PROFILE_RENDER_BATCH,
  bulkProfileRenderLimit,
  bulkProfileQueueMetric,
  bulkPublicationProjection,
  filterBulkProfiles,
  selectBulkProfileRange,
  selectAllBulkProfileIds,
  sortBulkProfilesByQueue,
  toggleBulkProfileSelection,
} from './bulk-ui.ts';

test('limita o DOM inicial sem alterar o total lógico de 500 perfis', () => {
  assert.equal(BULK_PROFILE_RENDER_BATCH, 80);
  assert.equal(bulkProfileRenderLimit(0, 500), 80);
  assert.equal(bulkProfileRenderLimit(80, 500), 160);
  assert.equal(bulkProfileRenderLimit(480, 500), 500);
});

test('renderização progressiva funciona para listas menores e entradas defensivas', () => {
  assert.equal(bulkProfileRenderLimit(0, 35), 35);
  assert.equal(bulkProfileRenderLimit(-20, 500), 80);
  assert.equal(bulkProfileRenderLimit(80, 500, 0), 81);
});

test('selecionar todos considera perfis filtrados ainda não renderizados', () => {
  const filteredIds = Array.from({ length: 500 }, (_, index) => `profile-${index}`);
  const selected = selectAllBulkProfileIds(['profile-existing', 'profile-0'], filteredIds);
  assert.equal(selected.length, 501);
  assert.equal(selected.at(-1), 'profile-499');
  assert.equal(new Set(selected).size, selected.length);
});

test('projeta 500 perfis sem expandir perfil por slot', () => {
  assert.deepEqual(bulkPublicationProjection('1', '60', 500), {
    slotsPerProfile: BigInt(24),
    expectedPublications: BigInt(12000),
  });
});

test('projeção usa bigint e tolera campos temporariamente inválidos', () => {
  assert.deepEqual(bulkPublicationProjection('1000000000000', '1', 500), {
    slotsPerProfile: BigInt('1440000000000000'),
    expectedPublications: BigInt('720000000000000000'),
  });
  assert.deepEqual(bulkPublicationProjection('', '60', 500), {
    slotsPerProfile: BigInt(0),
    expectedPublications: BigInt(0),
  });
});

test('projeção diária usa exatamente um slot por dia para cada perfil', () => {
  assert.deepEqual(bulkPublicationProjection('7', '60', 35, 'daily_time'), {
    slotsPerProfile: BigInt(7),
    expectedPublications: BigInt(245),
  });
});

function profile(id: string, username: string, published: number, scheduled: number) {
  return {
    id,
    username,
    publication_metrics: {
      published: { image: 0, reel: published, story: 0 },
      scheduled: { image: 0, reel: scheduled, story: 0 },
    },
  };
}

test('indicador usa somente publicadas e agendadas ativas do formato', () => {
  assert.deepEqual(bulkProfileQueueMetric(profile('a', 'ana', 11, 211), 'reel'), {
    published: 11,
    scheduled: 211,
    total: 222,
    remaining: 211,
    progress: (11 / 222) * 100,
  });
  assert.deepEqual(bulkProfileQueueMetric(profile('a', 'ana', 11, 211), 'image'), {
    published: 0,
    scheduled: 0,
    total: 0,
    remaining: 0,
    progress: 0,
  });
});

test('ordena 0/0 primeiro e depois pelo menor saldo restante', () => {
  const sorted = sortBulkProfilesByQueue([
    profile('c', 'carla', 30, 20),
    profile('b', 'bia', 10, 2),
    profile('a', 'ana', 0, 0),
    profile('d', 'duda', 4, 2),
  ], 'reel');
  assert.deepEqual(sorted.map((item) => item.id), ['a', 'd', 'b', 'c']);
});

test('filtra grupo e busca sem alterar o snapshot de entrada', () => {
  const profiles = [profile('a', 'Ana.Criadora', 0, 0), profile('b', 'Bia', 0, 0), profile('c', 'Carla', 0, 0)];
  const filtered = filterBulkProfiles(profiles, 'ANA', new Set(['a', 'b']));
  assert.deepEqual(filtered.map((item) => item.id), ['a']);
  assert.deepEqual(profiles.map((item) => item.id), ['a', 'b', 'c']);
});

test('seleção com shift inclui todo o intervalo lógico e preserva seleção anterior', () => {
  assert.deepEqual(
    selectBulkProfileRange(['outside', 'a'], ['a', 'b', 'c', 'd'], 'd', 'a', true),
    ['outside', 'a', 'b', 'c', 'd'],
  );
});

test('seleção com shift usa a nova ordenação após trocar o formato', () => {
  assert.deepEqual(
    selectBulkProfileRange(['a'], ['c', 'a', 'b', 'd'], 'd', 'a', true),
    ['a', 'b', 'd'],
  );
});

test('âncora e seleção são atualizadas atomicamente entre troca de formato e shift', () => {
  const afterFirstClick = toggleBulkProfileSelection(
    { ids: [], anchorId: null },
    ['a', 'b', 'c', 'd'],
    'a',
    false,
  );
  const afterFormatChange = toggleBulkProfileSelection(
    afterFirstClick,
    ['c', 'a', 'b', 'd'],
    'd',
    true,
  );
  assert.deepEqual(afterFormatChange, { ids: ['a', 'b', 'd'], anchorId: 'd' });
});

test('recupera a última seleção visível quando o filtro ocultou a âncora', () => {
  assert.deepEqual(
    toggleBulkProfileSelection(
      { ids: ['outside', 'a', 'c'], anchorId: 'outside' },
      ['a', 'b', 'c', 'd'],
      'd',
      true,
    ),
    { ids: ['outside', 'a', 'c', 'd'], anchorId: 'd' },
  );
});

test('seleção com shift volta à alternância quando a âncora saiu do filtro', () => {
  assert.deepEqual(selectBulkProfileRange(['a'], ['b', 'c'], 'c', 'a', true), ['a', 'c']);
  assert.deepEqual(selectBulkProfileRange(['a', 'c'], ['b', 'c'], 'c', null, false), ['a']);
});
