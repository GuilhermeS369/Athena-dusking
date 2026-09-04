import assert from 'node:assert/strict';
import test from 'node:test';

import { isRetryableGraphFailure, META_AUTHENTICATION_ERROR_CODE, metaContainerVerdict } from './meta-graph-errors.ts';

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
