import assert from 'node:assert/strict';
import test from 'node:test';

import { isRetryableGraphFailure, META_AUTHENTICATION_ERROR_CODE } from './meta-graph-errors.ts';

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
