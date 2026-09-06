import assert from 'node:assert/strict';
import test from 'node:test';

import { isMetaAppApiBlocked, metaAppApiFailureKind, isRetryableGraphFailure, META_AUTHENTICATION_ERROR_CODE, metaContainerVerdict } from './meta-graph-errors.ts';

test('token vencido ou revogado adia a publicação, nunca a encerra', () => {
  // Era este o caso que matava o post na primeira tentativa. Depois da migração
  // para apps próprios ele deixa de ser raro: o token de longa duração vive 60
  // dias e a renovação é rotina, então um 401 é quase sempre temporário.
  assert.equal(isRetryableGraphFailure(401), true);
  assert.equal(isRetryableGraphFailure(400, META_AUTHENTICATION_ERROR_CODE), true);
});

test('um segredo de app rotacionado não pode derrubar os cem perfis do app', () => {
  // Todos os perfis do app respondem igual; se um 401 fosse terminal, a fila
  // inteira daquele app morreria junto em vez de esperar a credencial voltar.
  const respostas = Array.from({ length: 100 }, () => isRetryableGraphFailure(401, 190));

  assert.equal(respostas.every(Boolean), true);
});

test('indisponibilidade e excesso de chamadas continuam adiando', () => {
  assert.equal(isRetryableGraphFailure(500), true);
  assert.equal(isRetryableGraphFailure(503), true);
  assert.equal(isRetryableGraphFailure(429), true);
  assert.equal(isRetryableGraphFailure(400, 1, true), true);
});

test('erro de conteúdo continua terminal: repetir não muda o resultado', () => {
  // Legenda recusada, mídia inválida, permissão ausente. Adiar aqui só gastaria
  // as cinco tentativas para chegar ao mesmo lugar.
  assert.equal(isRetryableGraphFailure(400), false);
  assert.equal(isRetryableGraphFailure(403), false);
  assert.equal(isRetryableGraphFailure(404), false);
  assert.equal(isRetryableGraphFailure(400, 100), false);
});

test('ERROR do contêiner adia; foi encerrar na primeira leitura que custou 76 posts', () => {
  // 04/09/2026: 76 publicações encerradas em definitivo por um ERROR que a
  // própria Meta desmentiu minutos depois, respondendo FINISHED nos MESMOS
  // contêineres. Um foi publicado à mão, sem correção nenhuma, e foi ao ar.
  const veredito = metaContainerVerdict('ERROR');

  assert.equal(veredito.kind, 'fail');
  assert.equal(veredito.kind === 'fail' && veredito.retryable, true);
});

test('EXPIRED encerra: passou das 24h e o contêiner não volta', () => {
  // A distinção com ERROR é o ponto. Adiar aqui gastaria tentativas contra algo
  // que a Meta já descartou.
  const veredito = metaContainerVerdict('EXPIRED');

  assert.equal(veredito.kind, 'fail');
  assert.equal(veredito.kind === 'fail' && veredito.retryable, false);
});

test('o motivo informado pela Meta chega até a mensagem', () => {
  // Antes de 04/09 pedíamos só `status_code`, então todo erro chegava como
  // "ERROR" pelado e não havia por onde começar a investigar.
  const comMotivo = metaContainerVerdict('ERROR', 'The media could not be fetched');
  const semMotivo = metaContainerVerdict('ERROR');

  assert.equal(comMotivo.kind === 'fail' && comMotivo.message.includes('The media could not be fetched'), true);
  assert.equal(semMotivo.kind === 'fail' && semMotivo.message.includes('não informou o motivo'), true);
});

test('FINISHED publica, PUBLISHED não republica, IN_PROGRESS espera', () => {
  // PUBLISHED existe porque a resposta do media_publish pode se perder depois de
  // a Meta ter concluído: repetir criaria post duplicado.
  assert.equal(metaContainerVerdict('FINISHED').kind, 'publish');
  assert.equal(metaContainerVerdict('PUBLISHED').kind, 'already_published');
  assert.equal(metaContainerVerdict('IN_PROGRESS').kind, 'wait');
  assert.equal(metaContainerVerdict(undefined).kind, 'wait');
});

test('"API access blocked" é reconhecido como bloqueio do app', () => {
  // A mensagem exata que a Meta devolveu em 05/09/2026 para 4 dos 28 apps.
  assert.equal(isMetaAppApiBlocked({ errorCode: '200', errorMessage: 'API access blocked.' }), true);
  assert.equal(isMetaAppApiBlocked({ errorCode: '200', errorMessage: '(#200) API access blocked' }), true);
});

test('o 200 sozinho não bloqueia app nenhum', () => {
  // 200 é o código genérico de permissão da Graph API. Sem a mensagem certa,
  // tratar como bloqueio de app pararia ~100 perfis por um erro de escopo de um
  // único perfil — exatamente o erro de unidade que este tratamento corrige.
  assert.equal(
    isMetaAppApiBlocked({ errorCode: '200', errorMessage: '(#200) Requires instagram_content_publish permission' }),
    false,
  );
  assert.equal(isMetaAppApiBlocked({ errorCode: '200', errorMessage: '' }), false);
  assert.equal(isMetaAppApiBlocked({ errorCode: '200' }), false);
});

test('bloqueio de app não se confunde com token inválido', () => {
  // 190 tem tratamento próprio: remove o perfil. Se a mensagem de bloqueio
  // chegasse com 190, remover ~100 perfis de um app que só está fechado
  // temporariamente seria irreversível pelo painel.
  assert.equal(isMetaAppApiBlocked({ errorCode: '190', errorMessage: 'API access blocked.' }), false);
  assert.equal(isMetaAppApiBlocked({ errorCode: '', errorMessage: 'API access blocked.' }), false);
});

test('"API access deactivated" também é bloqueio de app', () => {
  // A mensagem que a Meta passou a devolver em 06/09/2026, às 00:21, nos mesmos
  // apps. Não reconhecê-la fez três lotes pausarem e congelou 14.482 itens.
  assert.equal(metaAppApiFailureKind({ errorCode: '200', errorMessage: 'API access deactivated.' }), 'deactivated');
  assert.equal(isMetaAppApiBlocked({ errorCode: '200', errorMessage: 'API access deactivated.' }), true);
});

test('bloqueado e desativado são distinguidos, porque a ação é outra', () => {
  // blocked pode reabrir sozinho; deactivated exige religar as contas em outro
  // app. A tela precisa dizer coisas diferentes.
  assert.equal(metaAppApiFailureKind({ errorCode: '200', errorMessage: 'API access blocked.' }), 'blocked');
  assert.equal(metaAppApiFailureKind({ errorCode: '200', errorMessage: '(#200) Requires instagram_content_publish' }), null);
  assert.equal(metaAppApiFailureKind({ errorCode: '190', errorMessage: 'API access deactivated.' }), null);
});
