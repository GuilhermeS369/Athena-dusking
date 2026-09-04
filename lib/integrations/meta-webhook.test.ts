import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import {
  dataDeletionConfirmationCode,
  findMetaWebhookSigner,
  parseMetaSignedRequest,
  summarizeMetaWebhook,
  verifyMetaWebhookToken,
} from './meta-webhook.ts';

function sign(raw: string, secret: string) {
  return `sha256=${createHmac('sha256', secret).update(raw, 'utf8').digest('hex')}`;
}

function signedRequest(payload: Record<string, unknown>, secret: string) {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded, 'utf8').digest('base64url');

  return `${signature}.${encoded}`;
}

test('verifyMetaWebhookToken aceita apenas o token exato', () => {
  assert.equal(verifyMetaWebhookToken('segredo', 'segredo'), true);
  assert.equal(verifyMetaWebhookToken('segred', 'segredo'), false);
  assert.equal(verifyMetaWebhookToken('segredoo', 'segredo'), false);
  assert.equal(verifyMetaWebhookToken('outro', 'segredo'), false);
});

test('verifyMetaWebhookToken recusa quando falta token dos dois lados', () => {
  assert.equal(verifyMetaWebhookToken(null, 'segredo'), false);
  assert.equal(verifyMetaWebhookToken('segredo', undefined), false);
  assert.equal(verifyMetaWebhookToken('segredo', ''), false);
});

test('findMetaWebhookSigner identifica o app que assinou', () => {
  const raw = '{"object":"instagram","entry":[]}';
  const signers = [
    { appId: '111111', secret: 'secret-a' },
    { appId: '222222', secret: 'secret-b' },
  ];

  assert.deepEqual(findMetaWebhookSigner(raw, sign(raw, 'secret-b'), signers), signers[1]);
});

test('findMetaWebhookSigner recusa assinatura de outro corpo ou segredo', () => {
  const raw = '{"object":"instagram","entry":[]}';
  const signers = [{ appId: '111111', secret: 'secret-a' }];

  assert.equal(findMetaWebhookSigner(raw, sign('{"outro":true}', 'secret-a'), signers), null);
  assert.equal(findMetaWebhookSigner(raw, sign(raw, 'secret-errado'), signers), null);
});

test('findMetaWebhookSigner recusa header ausente ou malformado', () => {
  const raw = '{}';
  const signers = [{ appId: '111111', secret: 'secret-a' }];

  assert.equal(findMetaWebhookSigner(raw, null, signers), null);
  assert.equal(findMetaWebhookSigner(raw, 'sha1=abc', signers), null);
  assert.equal(findMetaWebhookSigner(raw, 'sha256=nao-hex', signers), null);
  assert.equal(findMetaWebhookSigner(raw, sign(raw, 'secret-a'), []), null);
});

test('summarizeMetaWebhook resume objeto, entradas e campos sem repetir', () => {
  const raw = JSON.stringify({
    object: 'instagram',
    entry: [
      { id: '17841448102220816', changes: [{ field: 'comments', value: { text: 'oi' } }] },
      { id: '17841448102220816', changes: [{ field: 'comments' }, { field: 'mentions' }] },
    ],
  });

  assert.deepEqual(summarizeMetaWebhook(raw), {
    object: 'instagram',
    entries: 2,
    fields: ['comments', 'mentions'],
  });
});

test('summarizeMetaWebhook devolve null para corpo que não é objeto JSON', () => {
  assert.equal(summarizeMetaWebhook('nao e json'), null);
  assert.equal(summarizeMetaWebhook('[1,2]'), null);
});

test('parseMetaSignedRequest devolve o app e a conta quando a assinatura bate', () => {
  const signers = [
    { appId: '111111', secret: 'secret-a' },
    { appId: '222222', secret: 'secret-b' },
  ];
  const raw = signedRequest({ user_id: '17841448102220816', issued_at: 1772000000 }, 'secret-b');

  assert.deepEqual(parseMetaSignedRequest(raw, signers), {
    signer: signers[1],
    userId: '17841448102220816',
    issuedAt: 1772000000,
  });
});

test('parseMetaSignedRequest recusa assinatura de outro segredo ou payload adulterado', () => {
  const signers = [{ appId: '111111', secret: 'secret-a' }];
  const valido = signedRequest({ user_id: '178414481' }, 'secret-a');
  const [assinatura] = valido.split('.');
  const outroPayload = Buffer.from(JSON.stringify({ user_id: '999' }), 'utf8').toString('base64url');

  assert.equal(parseMetaSignedRequest(signedRequest({ user_id: '178414481' }, 'outro'), signers), null);
  assert.equal(parseMetaSignedRequest(`${assinatura}.${outroPayload}`, signers), null);
});

test('parseMetaSignedRequest recusa formato inválido ou payload sem user_id', () => {
  const signers = [{ appId: '111111', secret: 'secret-a' }];

  assert.equal(parseMetaSignedRequest(null, signers), null);
  assert.equal(parseMetaSignedRequest('sem-ponto', signers), null);
  assert.equal(parseMetaSignedRequest(signedRequest({ issued_at: 1 }, 'secret-a'), signers), null);
  assert.equal(parseMetaSignedRequest(signedRequest({ user_id: '  ' }, 'secret-a'), signers), null);
});

test('dataDeletionConfirmationCode é estável por conta e diferente entre contas', () => {
  const signer = { appId: '111111', secret: 'secret-a' };
  const code = dataDeletionConfirmationCode(signer, '178414481');

  assert.match(code, /^[0-9A-F]{16}$/);
  assert.equal(dataDeletionConfirmationCode(signer, '178414481'), code);
  assert.notEqual(dataDeletionConfirmationCode(signer, '999999999'), code);
  assert.notEqual(dataDeletionConfirmationCode({ appId: '222222', secret: 'secret-b' }, '178414481'), code);
});
