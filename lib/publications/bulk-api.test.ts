import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bulkDatabaseErrorResponse,
  bulkRotationFingerprint,
  createBulkReviewToken,
  decodeBulkMediaCursor,
  encodeBulkMediaCursor,
  hasBulkManageRole,
  parseBulkIdempotencyKey,
  parseBulkRotationRequest,
  verifyBulkReviewToken,
} from './bulk-api.ts';

const request = parseBulkRotationRequest({
  name: ' Lote grande ',
  profileIds: ['30000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001'],
  origin: { type: 'ungrouped', groupId: null },
  format: 'story', intervalMinutes: 60, durationDays: 3, caption: 'Linha 1\nLinha 2',
  orderMode: 'diversified', rotationSeed: 'seed-estável',
});

test('normaliza contrato compacto sem expandir publicações', () => {
  assert.equal(request.name, 'Lote grande');
  assert.deepEqual(request.profileIds, ['30000000-0000-4000-8000-000000000001']);
  assert.equal(request.durationDays, '3');
  assert.equal(request.caption, 'Linha 1\nLinha 2');
});

test('aceita horário diário fixo e o vincula ao contrato revisado', () => {
  const dailyRequest = parseBulkRotationRequest({
    ...request,
    scheduleMode: 'daily_time',
    intervalMinutes: undefined,
    durationDays: 7,
    dailyTime: '21:00',
  });
  assert.equal(dailyRequest.scheduleMode, 'daily_time');
  assert.equal(dailyRequest.dailyTime, '21:00');
  assert.equal(dailyRequest.durationDays, '7');
  assert.equal(dailyRequest.intervalMinutes, 1440);
  assert.throws(() => parseBulkRotationRequest({ ...dailyRequest, dailyTime: '24:00' }), /Horário diário/);
});

test('rejeita perfis, origem e legenda inválidos', () => {
  assert.throws(() => parseBulkRotationRequest({ ...request, profileIds: [] }), /Perfis/);
  assert.throws(() => parseBulkRotationRequest({ ...request, origin: { type: 'group', groupId: 'inválido' } }), /Grupo/);
  assert.throws(() => parseBulkRotationRequest({ ...request, caption: 'x'.repeat(2201) }), /Legenda/);
});

test('normaliza capa de Reel e a inclui no fingerprint revisado', () => {
  const reel = parseBulkRotationRequest({
    ...request,
    format: 'reel',
    reelCover: {
      enabled: true,
      origin: { type: 'group', groupId: '40000000-0000-4000-8000-000000000001' },
      mediaAssetId: '50000000-0000-4000-8000-000000000001',
    },
  });
  assert.deepEqual(reel.reelCover, {
    enabled: true,
    origin: { type: 'group', groupId: '40000000-0000-4000-8000-000000000001' },
    mediaAssetId: '50000000-0000-4000-8000-000000000001',
  });
  assert.notEqual(bulkRotationFingerprint(reel), bulkRotationFingerprint({ ...reel, reelCover: { enabled: false } }));
  assert.throws(() => parseBulkRotationRequest({ ...request, reelCover: reel.reelCover }), /só pode ser usada em Reel/);
  assert.throws(() => parseBulkRotationRequest({ ...reel, reelCover: { ...reel.reelCover, mediaAssetId: 'inválido' } }), /Imagem de capa/);
});

test('token de revisão vincula organização, conteúdo e expiração', () => {
  const previousSecret = process.env.BULK_REVIEW_SECRET;
  try {
    process.env.BULK_REVIEW_SECRET = 'segredo-de-teste-com-mais-de-trinta-e-dois-caracteres';
    const token = createBulkReviewToken({ organizationId: 'org-1', fingerprint: bulkRotationFingerprint(request), expiresAt: 2000 });
    assert.equal(verifyBulkReviewToken(token, 'org-1', request, 1000), true);
    assert.equal(verifyBulkReviewToken(token, 'org-2', request, 1000), false);
    assert.equal(verifyBulkReviewToken(token, 'org-1', { ...request, intervalMinutes: 30 }, 1000), false);
    assert.equal(verifyBulkReviewToken(token, 'org-1', request, 2001), false);
  } finally {
    if (previousSecret === undefined) delete process.env.BULK_REVIEW_SECRET;
    else process.env.BULK_REVIEW_SECRET = previousSecret;
  }
});

test('cursor de miniaturas é opaco e validado', () => {
  const cursor = encodeBulkMediaCursor({ createdAt: '2026-08-13T10:00:00.000Z', id: '40000000-0000-4000-8000-000000000001' });
  assert.deepEqual(decodeBulkMediaCursor(cursor), { createdAt: '2026-08-13T10:00:00.000Z', id: '40000000-0000-4000-8000-000000000001' });
  assert.equal(decodeBulkMediaCursor('inválido'), null);
});

test('valida chave idempotente compacta e mapeia erros transacionais', () => {
  assert.equal(parseBulkIdempotencyKey('  request-2026-08-13-001  '), 'request-2026-08-13-001');
  assert.throws(() => parseBulkIdempotencyKey('curta'), RangeError);
  assert.deepEqual(bulkDatabaseErrorResponse({ code: '23505', message: 'Conflito.' }), { status: 409, message: 'Conflito.' });
  assert.deepEqual(bulkDatabaseErrorResponse({ code: 'P0001', message: 'Revise.' }), { status: 400, message: 'Revise.' });
  assert.deepEqual(bulkDatabaseErrorResponse({ code: '42501', message: 'Negado.' }), { status: 403, message: 'Negado.' });
  assert.deepEqual(bulkDatabaseErrorResponse({ code: 'XX000', message: 'Detalhe interno.' }), {
    status: 500,
    message: 'Não foi possível processar a programação em massa.',
  });
});

test('autoriza somente administradores e operadores a revisar ou confirmar', () => {
  assert.equal(hasBulkManageRole('admin'), true);
  assert.equal(hasBulkManageRole('operator'), true);
  assert.equal(hasBulkManageRole('viewer'), false);
  assert.equal(hasBulkManageRole(undefined), false);
});
