import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatTwitterGrantInput,
  parseTwitterInitialGrantUsd,
  parseTwitterZernioImport,
} from './zernio-import.ts';

test('saldo inicial X converte decimal para micros sem ponto flutuante', () => {
  assert.equal(parseTwitterInitialGrantUsd('17'), 17_000_000);
  assert.equal(parseTwitterInitialGrantUsd('17,25'), 17_250_000);
  assert.equal(parseTwitterInitialGrantUsd('0.015'), 15_000);
  assert.equal(parseTwitterInitialGrantUsd('17.123456'), 17_123_456);
  assert.equal(parseTwitterInitialGrantUsd('17.1234567'), null);
  assert.equal(formatTwitterGrantInput(17_250_000), '17,25');
});

test('lote X preserva pareamento, bloqueia repetidos e congela opções do lote', () => {
  const valid = parseTwitterZernioImport('Conta A\nConta B', 'sk_aaaaaaaaaaaa\nsk_bbbbbbbbbbbb', '17,00', 3);
  assert.equal(valid.valid, true);
  assert.equal(valid.initialGrantMicros, 17_000_000);
  assert.equal(valid.twitterSlotLimit, 3);
  assert.deepEqual(valid.rows.map((row) => row.label), ['Conta A', 'Conta B']);

  const repeated = parseTwitterZernioImport('Conta A\nconta a', 'sk_aaaaaaaaaaaa\nsk_aaaaaaaaaaaa', '17', 3);
  assert.equal(repeated.valid, false);
  assert.match(repeated.issues.map((issue) => issue.message).join(' '), /Nome repetido/);
  assert.match(repeated.issues.map((issue) => issue.message).join(' '), /API key repetida/);
});

test('lote X rejeita saldo e limite fora do contrato', () => {
  assert.equal(parseTwitterZernioImport('Conta A', 'sk_aaaaaaaaaaaa', '0', 2).valid, false);
  assert.equal(parseTwitterZernioImport('Conta A', 'sk_aaaaaaaaaaaa', '12', 0).valid, false);
});
