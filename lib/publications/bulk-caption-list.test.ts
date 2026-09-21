import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_BULK_CAPTION_LIST_TOTAL_LENGTH,
  MAX_BULK_CAPTION_VARIANTS,
  parseBulkCaptionList,
  validateBulkCaptionVariants,
} from './bulk-caption-list.ts';
import { bulkRotationMediaIndex } from './bulk-rotation.ts';

test('separa no ";", apara as pontas e mantém as quebras de linha de dentro', () => {
  const result = parseBulkCaptionList('  Primeira\nlinha dois  ;\n\n Segunda ; Terceira\n');
  assert.deepEqual(result.items, ['Primeira\nlinha dois', 'Segunda', 'Terceira']);
  assert.deepEqual(result.errors, []);
  assert.equal(result.longest, 'Primeira\nlinha dois'.length);
  assert.equal(result.total, 'Primeira\nlinha dois'.length + 'Segunda'.length + 'Terceira'.length);
});

test('um ";" no fim é ignorado, com ou sem espaço depois', () => {
  assert.deepEqual(parseBulkCaptionList('a; b;').items, ['a', 'b']);
  assert.deepEqual(parseBulkCaptionList('a; b; \n ').errors, []);
});

test('item vazio no meio ou no começo é erro, com número e linha', () => {
  const doubled = parseBulkCaptionList('a;\n;b');
  assert.deepEqual(doubled.items, ['a', 'b']);
  assert.match(doubled.errors[0], /^Legenda 2 \(linha 2\) está vazia/);
  assert.match(parseBulkCaptionList(';a;b').errors[0], /^Legenda 1 \(linha 1\) está vazia/);
});

test('o ";" de largura cheia do japonês não separa', () => {
  const japanese = '#TVアニメ 『STREET』 街角；夜の商店街!!; #TVアニメ 『STREET』 雨の日の奇跡!!';
  assert.deepEqual(parseBulkCaptionList(japanese).items, ['#TVアニメ 『STREET』 街角；夜の商店街!!', '#TVアニメ 『STREET』 雨の日の奇跡!!']);
});

test('espaço não quebrável e espaço japonês nas pontas são aparados', () => {
  assert.deepEqual(parseBulkCaptionList(' a ;　b　').items, ['a', 'b']);
});

test('legendas iguais são erro, apontando as duas', () => {
  const result = parseBulkCaptionList('a; b; a ; c; b');
  assert.deepEqual(result.errors, ['Legendas 1 e 3 são iguais.', 'Legendas 2 e 5 são iguais.']);
});

test('o limite de 2.200 conta unidades UTF-16, como o contador de hoje', () => {
  // Cada 🚨 ocupa 2 unidades: 1.100 cabem, 1.101 não.
  assert.deepEqual(parseBulkCaptionList(`${'🚨'.repeat(1100)};b`).errors, []);
  assert.match(parseBulkCaptionList(`${'🚨'.repeat(1101)};b`).errors[0], /^Legenda 1 \(linha 1\) tem 2\.202 caracteres; o limite é 2\.200\./);
});

test('precisa de pelo menos 2 legendas; vazio e uma só dão a mesma orientação', () => {
  for (const text of ['', '   ', 'só uma', 'só uma;', ';']) {
    const result = parseBulkCaptionList(text);
    assert.ok(result.errors.some((error) => /pelo menos 2 legendas/.test(error)), `texto ${JSON.stringify(text)}`);
  }
});

test('teto de 1.000 legendas e de 300.000 caracteres na lista inteira', () => {
  const many = Array.from({ length: MAX_BULK_CAPTION_VARIANTS + 1 }, (_, index) => `legenda ${index}`).join(';');
  assert.ok(parseBulkCaptionList(many).errors.some((error) => /máximo é 1\.000 legendas/.test(error)));
  const huge = Array.from({ length: 137 }, (_, index) => `${index}`.padEnd(2200, 'x')).join(';');
  const result = parseBulkCaptionList(huge);
  assert.ok(result.total > MAX_BULK_CAPTION_LIST_TOTAL_LENGTH);
  assert.ok(result.errors.some((error) => /máximo é 300\.000/.test(error)));
});

test('o servidor valida a lista já separada e o resultado passa idêntico de novo', () => {
  const once = validateBulkCaptionVariants([' a ', 'b\nlinha 2', 'c']);
  assert.deepEqual(once, ['a', 'b\nlinha 2', 'c']);
  assert.deepEqual(validateBulkCaptionVariants(once), once);
  assert.throws(() => validateBulkCaptionVariants(['a']), /pelo menos 2/);
  assert.throws(() => validateBulkCaptionVariants(['a', ' ']), /Legenda 2 está vazia/);
  assert.throws(() => validateBulkCaptionVariants(['a', 'a ']), /Legendas 1 e 2 são iguais/);
  assert.throws(() => validateBulkCaptionVariants('a;b'), /Lista de legendas inválida/);
  assert.throws(() => validateBulkCaptionVariants(['a', 2]), /Lista de legendas inválida/);
});

// O banco escolhe a legenda de cada post com o mesmo desenho do rodízio de mídias:
// ordinal = mod(ponto_de_partida + slot * passo, N), com passo coprimo com N.
test('o rodízio nunca repete a legenda do post anterior e cobre todas a cada N posts', () => {
  for (const [count, step, offset] of [[2, 1, 1], [3, 2, 0], [12, 5, 7], [45, 22, 13]]) {
    const picks = Array.from({ length: count * 3 }, (_, slot) => bulkRotationMediaIndex({ slotIndex: slot, profileOffset: offset, profileStep: step, mediaCount: count }));
    for (let slot = 1; slot < picks.length; slot += 1) assert.notEqual(picks[slot], picks[slot - 1], `N=${count}`);
    for (let start = 0; start + count <= picks.length; start += count) {
      assert.equal(new Set(picks.slice(start, start + count)).size, count, `N=${count}`);
    }
  }
});
