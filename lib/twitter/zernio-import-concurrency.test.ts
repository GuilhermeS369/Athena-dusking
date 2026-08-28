import assert from 'node:assert/strict';
import test from 'node:test';

import { forEachWithConcurrency, twitterZernioImportConcurrency } from './zernio-import-concurrency.ts';

test('importação Zernio usa concorrência quatro por padrão e limita configurações extremas', () => {
  assert.equal(twitterZernioImportConcurrency(undefined), 4);
  assert.equal(twitterZernioImportConcurrency('0'), 1);
  assert.equal(twitterZernioImportConcurrency('4'), 4);
  assert.equal(twitterZernioImportConcurrency('100'), 8);
  assert.equal(twitterZernioImportConcurrency('inválido'), 4);
});

test('pool processa todas as linhas sem ultrapassar a concorrência configurada', async () => {
  let active = 0;
  let maximumActive = 0;
  const completed: number[] = [];

  await forEachWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 4, async (item) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    completed.push(item);
    active -= 1;
  });

  assert.equal(maximumActive, 4);
  assert.deepEqual(completed.sort((left, right) => left - right), [1, 2, 3, 4, 5, 6, 7, 8]);
});
