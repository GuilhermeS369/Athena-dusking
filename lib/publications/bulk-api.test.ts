import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BULK_VIDEO_VARIANT_RECIPES,
  bulkDatabaseErrorResponse,
  bulkRotationFingerprint,
  createBulkReviewToken,
  decodeBulkMediaCursor,
  encodeBulkMediaCursor,
  hasBulkManageRole,
  isBulkVideoVariantAllowed,
  parseBulkIdempotencyKey,
  parseBulkRotationRequest,
  reelCoverIneligibleReason,
  sequentialStartAtError,
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

test('esquema sequencial aceita intervalo abaixo de 29 minutos, quantidade e início opcional em horário de São Paulo', () => {
  const sequential = parseBulkRotationRequest({
    ...request,
    format: 'reel',
    scheduleMode: 'sequential',
    intervalMinutes: 5,
    postCount: 12,
    durationDays: '1',
    startAt: '2026-09-20T21:00',
  });
  assert.equal(sequential.scheduleMode, 'sequential');
  assert.equal(sequential.intervalMinutes, 5);
  assert.equal(sequential.postCount, '12');
  assert.equal(sequential.durationDays, '1');
  assert.equal(sequential.startAt, '2026-09-21T00:00:00.000Z');
  assert.equal(sequential.dailyTime, null);
  // O pedido revisado volta com ISO, e precisa gerar o mesmo fingerprint na confirmação.
  assert.equal(bulkRotationFingerprint(parseBulkRotationRequest(sequential)), bulkRotationFingerprint(sequential));

  const semInicio = parseBulkRotationRequest({ ...sequential, startAt: null });
  assert.equal(semInicio.startAt, null);
  assert.notEqual(bulkRotationFingerprint(semInicio), bulkRotationFingerprint(sequential));

  // Os outros esquemas não carregam campos do sequencial.
  assert.equal(request.postCount, null);
  assert.equal(request.startAt, null);
});

test('esquema sequencial barra o que a Meta ou o teto de 7 dias recusariam', () => {
  const base = { ...request, scheduleMode: 'sequential', intervalMinutes: 5, postCount: 12, startAt: null };
  assert.throws(() => parseBulkRotationRequest({ ...base, intervalMinutes: 0 }), /pelo menos 1 minuto/);
  assert.throws(() => parseBulkRotationRequest({ ...base, postCount: 0 }), /Quantidade de postagens/);
  assert.throws(() => parseBulkRotationRequest({ ...base, intervalMinutes: 14, postCount: 101 }), /100 publicações em 24 horas/);
  assert.doesNotThrow(() => parseBulkRotationRequest({ ...base, intervalMinutes: 15, postCount: 200 }));
  assert.throws(() => parseBulkRotationRequest({ ...base, intervalMinutes: 120, postCount: 85 }), /passa de 7 dias/);
  assert.throws(() => parseBulkRotationRequest({ ...base, startAt: 'amanhã' }), /Horário inicial/);
  assert.throws(() => parseBulkRotationRequest({ ...base, startAt: '2026-02-30T10:00' }), /Horário inicial/);
});

test('início do sequencial precisa de 30 minutos de folga', () => {
  const now = Date.parse('2026-09-16T12:00:00.000Z');
  assert.equal(sequentialStartAtError(null, now), null);
  assert.equal(sequentialStartAtError('2026-09-16T12:30:00.000Z', now), null);
  assert.match(sequentialStartAtError('2026-09-16T12:29:00.000Z', now) ?? '', /30 minutos/);
  assert.match(sequentialStartAtError('2026-09-16T12:05:00.000Z', now) ?? '', /30 minutos/);
});

test('capa de Reel só é aceita em JPEG até 8 MB, com o motivo em português', () => {
  assert.equal(reelCoverIneligibleReason({ mime_type: 'image/jpeg', size_bytes: 1_138_389 }), null);
  assert.equal(reelCoverIneligibleReason({ mime_type: 'IMAGE/JPG', size_bytes: null }), null);
  assert.match(reelCoverIneligibleReason({ mime_type: 'image/png', size_bytes: 10 }) ?? '', /JPEG \(esta imagem é PNG\)/);
  assert.match(reelCoverIneligibleReason({ mime_type: null }) ?? '', /JPEG/);
  assert.match(reelCoverIneligibleReason({ mime_type: 'image/jpeg', size_bytes: 8 * 1024 * 1024 + 1 }) ?? '', /8 MB/);
});

test('variante de vídeo: só Reel, só receita conhecida, e ausente não muda o fingerprint de hoje', () => {
  const base = {
    name: 'Reels', profileIds: ['30000000-0000-4000-8000-000000000001'], origin: { type: 'ungrouped', groupId: null },
    format: 'reel', intervalMinutes: 60, durationDays: 3, caption: null, orderMode: 'diversified', rotationSeed: 'seed',
  };
  const semVariante = parseBulkRotationRequest(base);
  assert.equal('videoVariant' in semVariante, false);
  assert.equal('videoVariant' in parseBulkRotationRequest({ ...base, videoVariant: null }), false);
  assert.equal(bulkRotationFingerprint(parseBulkRotationRequest({ ...base, videoVariant: null })), bulkRotationFingerprint(semVariante));

  const micro = parseBulkRotationRequest({ ...base, videoVariant: 'micro' });
  assert.equal(micro.videoVariant, 'micro');
  assert.notEqual(bulkRotationFingerprint(micro), bulkRotationFingerprint(semVariante));
  assert.notEqual(bulkRotationFingerprint(micro), bulkRotationFingerprint(parseBulkRotationRequest({ ...base, videoVariant: 'light' })));

  assert.throws(() => parseBulkRotationRequest({ ...base, videoVariant: 'visible' }), /variante de vídeo inválida/i);
  assert.throws(() => parseBulkRotationRequest({ ...base, format: 'story', videoVariant: 'micro' }), /só existe para Reels/);
  assert.deepEqual([...BULK_VIDEO_VARIANT_RECIPES], ['container', 'micro', 'light']);
});

test('variante de vídeo só é liberada para organização na allowlist; vazio libera ninguém', () => {
  const org = '695BE08F-3084-4046-A91D-9052B2A1582B';
  assert.equal(isBulkVideoVariantAllowed(org, ''), false);
  assert.equal(isBulkVideoVariantAllowed(org, undefined), false);
  assert.equal(isBulkVideoVariantAllowed(org, 'outra-org'), false);
  assert.equal(isBulkVideoVariantAllowed(org, ' outra , 695be08f-3084-4046-a91d-9052b2a1582b '), true);
  assert.equal(isBulkVideoVariantAllowed(org, '*'), true);
  // O que a colagem pelo PowerShell produz: quebra de linha, aspas, BOM, UTF-16.
  const a1 = '58785306-4dfb-432f-8de0-f0b33f91f3de';
  assert.equal(isBulkVideoVariantAllowed(org, a1 + '\r\n' + org.toLowerCase() + '\r\n'), true);
  assert.equal(isBulkVideoVariantAllowed(a1, '\ufeff"' + a1 + '","' + org + '"'), true);
  assert.equal(isBulkVideoVariantAllowed(a1, [...a1].join('\u0000')), true);
  assert.equal(isBulkVideoVariantAllowed(org, a1), false);
  assert.equal(isBulkVideoVariantAllowed(org, 'abc*def'), false);
});

test('lista de legendas: chave só aparece com lista, e sem ela o fingerprint é o de hoje', () => {
  const base = {
    name: 'Reels', profileIds: ['30000000-0000-4000-8000-000000000001'], origin: { type: 'ungrouped', groupId: null },
    format: 'reel', intervalMinutes: 60, durationDays: 3, caption: null, orderMode: 'diversified', rotationSeed: 'seed',
  };
  const semLista = parseBulkRotationRequest(base);
  assert.equal('captionVariants' in semLista, false);
  assert.equal('captionVariants' in parseBulkRotationRequest({ ...base, captionVariants: null }), false);
  assert.equal(bulkRotationFingerprint(parseBulkRotationRequest({ ...base, captionVariants: null })), bulkRotationFingerprint(semLista));

  const comLista = parseBulkRotationRequest({ ...base, captionVariants: [' A ', 'B\nlinha 2', 'C'] });
  assert.deepEqual(comLista.captionVariants, ['A', 'B\nlinha 2', 'C']);
  assert.equal(comLista.caption, null);
  assert.notEqual(bulkRotationFingerprint(comLista), bulkRotationFingerprint(semLista));
  // Revisar e confirmar passam o pedido pelo parser duas vezes: tem de sair igual.
  const deNovo = parseBulkRotationRequest(JSON.parse(JSON.stringify(comLista)));
  assert.deepEqual(deNovo, comLista);
  assert.equal(bulkRotationFingerprint(deNovo), bulkRotationFingerprint(comLista));
  // A ordem da lista faz parte do pedido.
  assert.notEqual(bulkRotationFingerprint(parseBulkRotationRequest({ ...base, captionVariants: ['C', 'B\nlinha 2', 'A'] })), bulkRotationFingerprint(comLista));
  // Convive com a variante de vídeo.
  const ambos = parseBulkRotationRequest({ ...base, videoVariant: 'micro', captionVariants: ['A', 'B'] });
  assert.equal(ambos.videoVariant, 'micro');
  assert.deepEqual(ambos.captionVariants, ['A', 'B']);
});

test('lista de legendas: recusa junto com legenda única, em Story e lista inválida', () => {
  const base = {
    name: 'Reels', profileIds: ['30000000-0000-4000-8000-000000000001'], origin: { type: 'ungrouped', groupId: null },
    format: 'reel', intervalMinutes: 60, durationDays: 3, caption: null, orderMode: 'diversified', rotationSeed: 'seed',
  };
  assert.throws(() => parseBulkRotationRequest({ ...base, caption: 'Única', captionVariants: ['A', 'B'] }), /não as duas/);
  assert.throws(() => parseBulkRotationRequest({ ...base, format: 'story', captionVariants: ['A', 'B'] }), /Story não leva legenda/);
  assert.throws(() => parseBulkRotationRequest({ ...base, captionVariants: ['A'] }), /pelo menos 2/);
  assert.throws(() => parseBulkRotationRequest({ ...base, captionVariants: ['A', 'A'] }), /iguais/);
  assert.throws(() => parseBulkRotationRequest({ ...base, captionVariants: ['A', 'x'.repeat(2201)] }), /limite é 2\.200/);
  assert.throws(() => parseBulkRotationRequest({ ...base, captionVariants: 'A;B' }), /Lista de legendas inválida/);
});
