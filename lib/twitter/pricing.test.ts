import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TWITTER_RATE_MICROS,
  containsHttpUrl,
  countTwitterWeightedCharacters,
  formatUsdMicros,
  getTwitterCreatePrice,
  validateTwitterContent,
} from './pricing.ts';

test('URLs contam 23 caracteres independentemente do tamanho', () => {
  assert.equal(countTwitterWeightedCharacters('a https://example.com/um/caminho/muito-grande z'), 27);
  assert.equal(containsHttpUrl('HTTPS://EXAMPLE.COM/teste'), true);
});

test('contagem de URL permanece determinística entre revisões consecutivas', () => {
  const content = 'Canário https://example.com/caminho-muito-longo';
  const first = countTwitterWeightedCharacters(content);
  assert.equal(containsHttpUrl(content), true);
  assert.equal(countTwitterWeightedCharacters(content), first);
  assert.deepEqual(getTwitterCreatePrice(content), {
    category: 'post_create_url',
    amountMicros: TWITTER_RATE_MICROS.postCreateWithUrl,
  });
  assert.equal(countTwitterWeightedCharacters(content), first);
});

test('emoji simples e composto contam duas unidades cada', () => {
  assert.equal(countTwitterWeightedCharacters('A😀B'), 4);
  assert.equal(countTwitterWeightedCharacters('👨‍👩‍👧‍👦'), 2);
});

test('capacidade desconhecida usa fallback Free', () => {
  assert.equal(validateTwitterContent('a'.repeat(280), 'unknown').valid, true);
  assert.equal(validateTwitterContent('a'.repeat(281), 'unknown').valid, false);
  assert.equal(validateTwitterContent('a'.repeat(281), 'premium').valid, true);
});

test('post com URL custa 0,200 total e sem URL custa 0,015', () => {
  assert.deepEqual(getTwitterCreatePrice('sem link'), {
    category: 'post_dm_create',
    amountMicros: TWITTER_RATE_MICROS.postOrDmCreate,
  });
  assert.deepEqual(getTwitterCreatePrice('acesse http://example.com'), {
    category: 'post_create_url',
    amountMicros: TWITTER_RATE_MICROS.postCreateWithUrl,
  });
  assert.equal(formatUsdMicros(12_000_000), 'US$ 12,000');
});
