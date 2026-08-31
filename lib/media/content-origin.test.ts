import assert from 'node:assert/strict';
import test from 'node:test';

import { contentOriginFromFileName, isReprocessedFileName } from './content-origin.ts';

test('reconhece os formatos reais do acervo', () => {
  // Amostras retiradas do acervo de producao em 31/08/2026.
  assert.equal(isReprocessedFileName('video_final_1785967172757_3_camuflado.mp4'), true);
  assert.equal(isReprocessedFileName('video_conjunto_1785810263828_54_camuflado.mp4'), true);
  assert.equal(isReprocessedFileName('V4_espelhado.mp4'), true);
});

test('saida crua do baixador e midia comum', () => {
  assert.equal(
    contentOriginFromFileName('lauralintv_1784896590_3948319961810165546_71479571452.mp4'),
    'common',
  );
  assert.equal(
    contentOriginFromFileName('[ANTIGO]_giovannatalamini__1772805259_3846891603541137510_4704017353.mp4'),
    'common',
  );
});

test('o radical pega as variacoes de genero e numero', () => {
  // Uma marca por radical, em vez de tres entradas quase iguais na lista.
  for (const nome of ['a_camuflado.mp4', 'b_camuflada.mp4', 'c_camuflados.mp4', 'd_espelhada.mp4']) {
    assert.equal(isReprocessedFileName(nome), true, nome);
  }
});

test('caixa e acento nao mudam o veredito', () => {
  assert.equal(isReprocessedFileName('VIDEO_CAMUFLADO.MP4'), true);
  assert.equal(isReprocessedFileName('video_camuflÁdo.mp4'), true);
});

test('nome ausente nao vira reprocessado por acidente', () => {
  assert.equal(contentOriginFromFileName(null), 'common');
  assert.equal(contentOriginFromFileName(undefined), 'common');
  assert.equal(contentOriginFromFileName(''), 'common');
});

test('nomes soltos do acervo nao sao classificados como reprocessados', () => {
  // Estes existem no acervo e sao o risco conhecido de falso negativo: nao ha
  // marca neles, entao entram como comuns. Documentado de proposito — inventar
  // uma regra para "V63.mp4" traria falso positivo em troca.
  for (const nome of ['V63.mp4', 'v2.mp4', 'seguidor novo recebe.mp4', 'story.jpg']) {
    assert.equal(contentOriginFromFileName(nome), 'common', nome);
  }
});
