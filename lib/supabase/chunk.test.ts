import assert from 'node:assert/strict';
import test from 'node:test';

import { chunkIds, fetchAllRowsByIds, runInIdChunks } from './chunk.ts';

const ids = (count: number) => Array.from({ length: count }, (_, index) => `id-${index}`);

test('chunkIds divide a lista sem perder nem duplicar ids', () => {
  const chunks = chunkIds(ids(450), 200);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [200, 200, 50]);
  assert.deepEqual(chunks.flat(), ids(450));
});

test('chunkIds devolve lista vazia para entrada vazia', () => {
  assert.deepEqual(chunkIds([], 200), []);
});

test('fetchAllRowsByIds pagina dentro de cada bloco e concatena tudo', async () => {
  // Relação 1:N: cada id devolve 3 linhas, então um bloco de 200 ids gera 600
  // linhas e precisa de mais de uma página quando o teto por página é 500.
  const pageSize = 500;
  const rowsById = (id: string) => [0, 1, 2].map((seq) => ({ id, seq }));
  const requestedRanges: Array<[number, number]> = [];

  const { data, error } = await fetchAllRowsByIds<{ id: string; seq: number }>(
    ids(450),
    (chunk, from, to) => {
      requestedRanges.push([from, to]);
      const all = chunk.flatMap(rowsById);
      return Promise.resolve({ data: all.slice(from, to + 1), error: null });
    },
    200,
  );

  assert.equal(error, null);
  assert.equal(data.length, 450 * 3);
  assert.equal(new Set(data.map((row) => `${row.id}:${row.seq}`)).size, 450 * 3);
  // fetchAllRows usa páginas de 1000; com 600 linhas por bloco basta uma página.
  assert.deepEqual(requestedRanges[0], [0, 999]);
  void pageSize;
});

test('fetchAllRowsByIds interrompe no primeiro erro e devolve o que já leu', async () => {
  let calls = 0;
  const { data, error } = await fetchAllRowsByIds<{ id: string }>(
    ids(450),
    (chunk) => {
      calls += 1;
      if (calls === 2) {
        return Promise.resolve({ data: null, error: { message: 'falhou', details: '', hint: '', code: '500', name: 'PostgrestError' } as never });
      }
      return Promise.resolve({ data: chunk.map((id) => ({ id })), error: null });
    },
    200,
  );

  assert.notEqual(error, null);
  assert.equal(data.length, 200);
  assert.equal(calls, 2);
});

test('runInIdChunks relata quantos ids foram processados antes da falha', async () => {
  let calls = 0;
  const result = await runInIdChunks(
    ids(450),
    () => {
      calls += 1;
      if (calls === 3) {
        return Promise.resolve({ error: { message: 'falhou', details: '', hint: '', code: '500', name: 'PostgrestError' } as never });
      }
      return Promise.resolve({ error: null });
    },
    200,
  );

  assert.equal(result.processed, 400);
  assert.notEqual(result.error, null);
});

test('runInIdChunks processa a lista inteira quando não há erro', async () => {
  const seen: string[] = [];
  const result = await runInIdChunks(ids(450), (chunk) => {
    seen.push(...chunk);
    return Promise.resolve({ error: null });
  }, 200);

  assert.equal(result.error, null);
  assert.equal(result.processed, 450);
  assert.deepEqual(seen, ids(450));
});
