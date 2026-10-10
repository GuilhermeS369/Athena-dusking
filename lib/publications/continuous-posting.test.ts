import assert from 'node:assert/strict';
import test from 'node:test';

import {
  continuousPostingErrorResponse,
  continuousPostingGuardMessage,
  hasContinuousPostingManageRole,
  isContinuousPostingAllowed,
  isContinuousPostingUuid,
  parseContinuousPostingClearInput,
  parseContinuousPostingGuardDetail,
  parseContinuousPostingRuleInput,
  parseContinuousPostingToggleInput,
} from './continuous-posting.ts';

const GROUP = '30000000-0000-4000-8000-000000000001';
const OTHER = '30000000-0000-4000-8000-000000000002';

test('allowlist: vazio libera ninguém, * libera todas, lista libera só quem está nela', () => {
  const org = '695BE08F-3084-4046-A91D-9052B2A1582B';
  const a1 = '58785306-4dfb-432f-8de0-f0b33f91f3de';
  assert.equal(isContinuousPostingAllowed(org, ''), false);
  assert.equal(isContinuousPostingAllowed(org, undefined), false);
  assert.equal(isContinuousPostingAllowed(org, 'outra-org'), false);
  assert.equal(isContinuousPostingAllowed(org, a1), false);
  assert.equal(isContinuousPostingAllowed(org, ' outra , 695be08f-3084-4046-a91d-9052b2a1582b '), true);
  assert.equal(isContinuousPostingAllowed(org, '*'), true);
  assert.equal(isContinuousPostingAllowed(org, 'abc*def'), false);
  // O que a colagem pelo PowerShell produz: quebra de linha, aspas, BOM, UTF-16.
  assert.equal(isContinuousPostingAllowed(org, a1 + '\r\n' + org.toLowerCase() + '\r\n'), true);
  assert.equal(isContinuousPostingAllowed(a1, '﻿"' + a1 + '","' + org + '"'), true);
  assert.equal(isContinuousPostingAllowed(a1, [...a1].join('\u0000')), true);
});

test('allowlist lê CONTINUOUS_POSTING_ORG_IDS quando nada é passado', () => {
  const previous = process.env.CONTINUOUS_POSTING_ORG_IDS;
  delete process.env.CONTINUOUS_POSTING_ORG_IDS;
  assert.equal(isContinuousPostingAllowed(GROUP), false);
  process.env.CONTINUOUS_POSTING_ORG_IDS = `${OTHER},${GROUP}`;
  assert.equal(isContinuousPostingAllowed(GROUP), true);
  if (previous === undefined) delete process.env.CONTINUOUS_POSTING_ORG_IDS;
  else process.env.CONTINUOUS_POSTING_ORG_IDS = previous;
});

test('papel: só admin e operator escrevem', () => {
  assert.equal(hasContinuousPostingManageRole('admin'), true);
  assert.equal(hasContinuousPostingManageRole('operator'), true);
  assert.equal(hasContinuousPostingManageRole('viewer'), false);
  assert.equal(hasContinuousPostingManageRole(undefined), false);
});

test('uuid', () => {
  assert.equal(isContinuousPostingUuid(GROUP), true);
  assert.equal(isContinuousPostingUuid('30000000-0000-4000-8000-00000000000'), false);
  assert.equal(isContinuousPostingUuid(`${GROUP} or 1=1`), false);
  assert.equal(isContinuousPostingUuid(null), false);
});

test('configuração de reel: normaliza e descarta a faixa de horário', () => {
  const rule = parseContinuousPostingRuleInput({
    format: 'reel', sourceGroupId: OTHER.toUpperCase(), rotationMode: 'diversified', postsPerDay: 24,
    windowStartMinute: 480, windowEndMinute: 1320, caption: '  Linha 1\nLinha 2  ',
  });
  assert.deepEqual(rule, {
    format: 'reel', sourceGroupId: OTHER, rotationMode: 'diversified', postsPerDay: 24,
    windowStartMinute: null, windowEndMinute: null, caption: 'Linha 1\nLinha 2',
  });
});

test('configuração: origem ausente fica nula (a rota usa o próprio grupo) e legenda vazia vira null', () => {
  const rule = parseContinuousPostingRuleInput({ format: 'reel', rotationMode: 'same_order', postsPerDay: 1, caption: '   ' });
  assert.equal(rule.sourceGroupId, null);
  assert.equal(rule.caption, null);
  assert.equal(rule.rotationMode, 'same_order');
});

test('posts por dia: reel 1–57, story 1–100, só inteiro', () => {
  const reel = (postsPerDay: unknown) => () => parseContinuousPostingRuleInput({ format: 'reel', rotationMode: 'diversified', postsPerDay });
  const story = (postsPerDay: unknown) => () => parseContinuousPostingRuleInput({ format: 'story', rotationMode: 'diversified', postsPerDay, windowStartMinute: 0, windowEndMinute: 1440 });
  assert.doesNotThrow(reel(1));
  assert.doesNotThrow(reel(57));
  assert.throws(reel(58), /entre 1 e 57/);
  assert.throws(reel(0), RangeError);
  assert.throws(reel(1.5), RangeError);
  assert.throws(reel('24'), RangeError);
  assert.throws(reel(undefined), RangeError);
  assert.doesNotThrow(story(100));
  assert.throws(story(101), /entre 1 e 100/);
});

test('story: faixa obrigatória, 0–1440, início antes do fim', () => {
  const story = (windowStartMinute: unknown, windowEndMinute: unknown) => () => parseContinuousPostingRuleInput({
    format: 'story', rotationMode: 'diversified', postsPerDay: 1, windowStartMinute, windowEndMinute,
  });
  assert.deepEqual(story(480, 1320)(), {
    format: 'story', sourceGroupId: null, rotationMode: 'diversified', postsPerDay: 1,
    windowStartMinute: 480, windowEndMinute: 1320, caption: null,
  });
  assert.doesNotThrow(story(0, 1440));
  assert.throws(story(undefined, 1320), /início/);
  assert.throws(story(480, null), /fim/);
  assert.throws(story(-1, 600), RangeError);
  assert.throws(story(0, 1441), RangeError);
  assert.throws(story(600, 600), /antes do fim/);
  assert.throws(story(900, 600), /antes do fim/);
  assert.throws(story(480.5, 600), RangeError);
});

test('configuração: recusa formato, ordem, origem e legenda inválidos', () => {
  const base = { format: 'reel', rotationMode: 'diversified', postsPerDay: 24 };
  assert.throws(() => parseContinuousPostingRuleInput(null), RangeError);
  assert.throws(() => parseContinuousPostingRuleInput([]), RangeError);
  assert.throws(() => parseContinuousPostingRuleInput({ ...base, format: 'feed' }), /Formato inválido/);
  assert.throws(() => parseContinuousPostingRuleInput({ ...base, rotationMode: 'random' }), /Ordem/);
  assert.throws(() => parseContinuousPostingRuleInput({ ...base, sourceGroupId: 'grupo' }), /Origem/);
  assert.throws(() => parseContinuousPostingRuleInput({ ...base, caption: 12 }), /Legenda/);
  assert.doesNotThrow(() => parseContinuousPostingRuleInput({ ...base, caption: 'a'.repeat(2200) }));
  assert.throws(() => parseContinuousPostingRuleInput({ ...base, caption: 'a'.repeat(2201) }), /2\.200/);
  // Emoji conta como um caractere, como no Postgres.
  assert.doesNotThrow(() => parseContinuousPostingRuleInput({ ...base, caption: '😀'.repeat(2200) }));
});

test('chave: exige formato e booleano', () => {
  assert.deepEqual(parseContinuousPostingToggleInput({ format: 'story', enabled: true }), { format: 'story', enabled: true });
  assert.deepEqual(parseContinuousPostingToggleInput({ format: 'reel', enabled: false }), { format: 'reel', enabled: false });
  assert.throws(() => parseContinuousPostingToggleInput({ format: 'reel', enabled: 'true' }), RangeError);
  assert.throws(() => parseContinuousPostingToggleInput({ enabled: true }), RangeError);
});

test('limpar avisos: remove repetidos, recusa id inválido e lista vazia', () => {
  assert.deepEqual(parseContinuousPostingClearInput({ noticeIds: [GROUP, GROUP.toUpperCase()], itemIds: [OTHER] }), { noticeIds: [GROUP], itemIds: [OTHER] });
  assert.deepEqual(parseContinuousPostingClearInput({ itemIds: [OTHER] }), { noticeIds: [], itemIds: [OTHER] });
  assert.throws(() => parseContinuousPostingClearInput({ noticeIds: [], itemIds: [] }), /1 a 1\.000/);
  assert.throws(() => parseContinuousPostingClearInput({}), /1 a 1\.000/);
  assert.throws(() => parseContinuousPostingClearInput({ noticeIds: ['x'] }), /inválida/);
  assert.throws(() => parseContinuousPostingClearInput({ noticeIds: GROUP }), /inválida/);
});

test('guarda de ligar: lê o detail em texto ou objeto e recusa o que não é da guarda', () => {
  const detail = { openItems: 12, activeHorizons: 0, eligibleMedia: 57, eligibleProfiles: 30 };
  assert.deepEqual(parseContinuousPostingGuardDetail(JSON.stringify(detail)), detail);
  assert.deepEqual(parseContinuousPostingGuardDetail(detail), detail);
  assert.equal(parseContinuousPostingGuardDetail('não é json'), null);
  assert.equal(parseContinuousPostingGuardDetail('{"openItems": 1}'), null);
  assert.equal(parseContinuousPostingGuardDetail(null), null);
});

test('guarda de ligar: frase clara por motivo', () => {
  const clean = { openItems: 0, activeHorizons: 0, eligibleMedia: 57, eligibleProfiles: 30 };
  assert.equal(
    continuousPostingGuardMessage({ ...clean, openItems: 12 }, 'reel'),
    'Este grupo ainda tem 12 reels na fila. Cancele a fila do grupo antes de ligar.',
  );
  assert.match(continuousPostingGuardMessage({ ...clean, openItems: 1 }, 'story'), /tem 1 story na fila/);
  assert.match(continuousPostingGuardMessage({ ...clean, activeHorizons: 3 }, 'reel'), /3 reservas ativas de agendamento em massa de reels/);
  assert.match(continuousPostingGuardMessage({ ...clean, eligibleMedia: 0 }, 'reel'), /nenhum vídeo pronto/);
  assert.match(continuousPostingGuardMessage({ ...clean, eligibleMedia: 0 }, 'story'), /nenhuma mídia pronta/);
  assert.match(continuousPostingGuardMessage({ ...clean, eligibleProfiles: 0 }, 'reel'), /Nenhum perfil deste grupo pode postar/);
  // Mais de um motivo: todos aparecem.
  const both = continuousPostingGuardMessage({ openItems: 2, activeHorizons: 0, eligibleMedia: 0, eligibleProfiles: 5 }, 'reel');
  assert.match(both, /2 reels na fila/);
  assert.match(both, /nenhum vídeo pronto/);
});

test('erro do banco: P0001 da guarda vira 409 com a frase; os demais códigos têm status próprio', () => {
  const guard = continuousPostingErrorResponse({
    code: 'P0001', message: 'continuous_posting_enable_blocked',
    details: '{"openItems": 12, "activeHorizons": 0, "eligibleMedia": 57, "eligibleProfiles": 30}',
  }, 'reel');
  assert.deepEqual(guard, { status: 409, message: 'Este grupo ainda tem 12 reels na fila. Cancele a fila do grupo antes de ligar.' });
  // `detail` (nome do contrato) também é aceito.
  assert.equal(continuousPostingErrorResponse({ code: 'P0001', detail: '{"openItems":0,"activeHorizons":0,"eligibleMedia":0,"eligibleProfiles":4}' }, 'story').status, 409);
  // P0001 sem o JSON da guarda: devolve a mensagem do banco.
  assert.deepEqual(continuousPostingErrorResponse({ code: 'P0001', message: ' Origem inválida. ' }), { status: 400, message: 'Origem inválida.' });

  assert.deepEqual(continuousPostingErrorResponse({ code: '42501', message: 'permission denied' }), { status: 403, message: 'Ação não permitida.' });
  assert.equal(continuousPostingErrorResponse({ code: 'P0002' }).status, 404);
  assert.equal(continuousPostingErrorResponse({ code: '23503' }).status, 400);
  assert.equal(continuousPostingErrorResponse({ code: '23514', message: 'posts_per_day fora do limite' }).message, 'posts_per_day fora do limite');
  assert.equal(continuousPostingErrorResponse({ code: '22023' }).status, 400);
  assert.equal(continuousPostingErrorResponse({ code: 'PGRST202' }).status, 503);
  // Erro desconhecido não vaza a mensagem do banco.
  assert.deepEqual(continuousPostingErrorResponse({ code: 'XX000', message: 'internal detail' }), {
    status: 500, message: 'Não foi possível concluir a operação da postagem contínua.',
  });
});
