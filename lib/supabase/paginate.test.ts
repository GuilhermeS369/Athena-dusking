import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchAllRows, POSTGREST_MAX_ROWS } from './paginate.ts';

/** Servidor falso que aplica o mesmo teto de linhas do PostgREST. */
function fakeTable(totalRows: number, maxRows = POSTGREST_MAX_ROWS) {
  const all = Array.from({ length: totalRows }, (_, index) => ({ id: index }));
  const requests: Array<[number, number]> = [];

  return {
    requests,
    page(rangeFrom: number, rangeTo: number) {
      requests.push([rangeFrom, rangeTo]);
      const requested = all.slice(rangeFrom, rangeTo + 1);
      return Promise.resolve({ data: requested.slice(0, maxRows), error: null });
    },
  };
}

test('lê todas as páginas quando o total passa do teto de linhas', async () => {
  const table = fakeTable(2450);
  const { data, error } = await fetchAllRows(table.page);

  assert.equal(error, null);
  assert.equal(data.length, 2450);
  assert.deepEqual(data.map((row) => row.id), Array.from({ length: 2450 }, (_, index) => index));
  assert.deepEqual(table.requests, [[0, 999], [1000, 1999], [2000, 2999]]);
});

test('para na primeira página quando o total cabe nela', async () => {
  const table = fakeTable(12);
  const { data } = await fetchAllRows(table.page);

  assert.equal(data.length, 12);
  assert.equal(table.requests.length, 1);
});

test('não pede página maior que o teto do servidor', async () => {
  const table = fakeTable(POSTGREST_MAX_ROWS * 2);

  // Com pageSize acima do teto, a primeira página voltaria cortada no teto, o
  // laço concluiria que acabou e devolveria só essa fatia, sem erro nenhum.
  await assert.rejects(
    () => fetchAllRows(table.page, POSTGREST_MAX_ROWS + 1),
    /excede o teto do PostgREST/,
  );
  assert.equal(table.requests.length, 0, 'não deve chegar a consultar o banco');
});

test('uma página exatamente do tamanho do teto ainda é segura', async () => {
  const table = fakeTable(POSTGREST_MAX_ROWS + 250);
  const { data } = await fetchAllRows(table.page, POSTGREST_MAX_ROWS);

  // Página cheia não encerra o laço: ele só para quando vem menos que o pedido.
  assert.equal(data.length, POSTGREST_MAX_ROWS + 250);
  assert.equal(table.requests.length, 2);
});

test('rejeita tamanho de página inválido', async () => {
  await assert.rejects(() => fetchAllRows(fakeTable(10).page, 0), /maior que zero/);
});

test('interrompe e devolve o que já leu quando uma página falha', async () => {
  let calls = 0;
  const all = Array.from({ length: 2500 }, (_, index) => ({ id: index }));

  const { data, error } = await fetchAllRows<{ id: number }>((rangeFrom, rangeTo) => {
    calls += 1;
    if (calls === 2) {
      return Promise.resolve({
        data: null,
        error: { message: 'falhou', details: '', hint: '', code: '500', name: 'PostgrestError' } as never,
      });
    }
    return Promise.resolve({ data: all.slice(rangeFrom, rangeTo + 1), error: null });
  });

  assert.notEqual(error, null);
  assert.equal(data.length, 1000);
  assert.equal(calls, 2);
});
