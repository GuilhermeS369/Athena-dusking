import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildZernioMediaItems,
  buildVerifiedMediaUrls,
  claimedProfileRemainsOnline,
  deferFirstZernioMediaDownloadFailure,
  ensureClaimedProfileOnlineOrSuspend,
  isMetaTerminalProfileDisconnection,
  isPublicationInfrastructureError,
  isZernioTerminalAccountDisconnection,
  loadWorkItem,
  mapWithConcurrency,
  nextAdaptiveDispatchLimit,
  preserveAcceptedProviderCreation,
  preserveConfirmedPublication,
  preserveReconciledZernioPublication,
  probeMediaUrl,
  recordZernioRequestTelemetry,
  retryZernioMediaDownloadOnSamePost,
  scheduleZernioMediaDownloadRecovery,
  sanitizedZernioDiagnostic,
  urlFingerprint,
  zernioOutcome,
  zernioFailureResult,
  zernioExistingPostId,
  zernioPollingDelaySeconds,
  zernioWorkItemRequiresManualReconciliation,
  validatePreparedPublicationWorkItem,
  flushZernioRequestTelemetry,
  ignoreExpiredUnstartedPublications,
  shouldActivateZernioBackpressure,
} from './publication-direct-dispatch.mjs';

test('limpeza automática não descarta backlog causado pela capacidade interna', async () => {
  const calls = [];
  const supabase = {
    rpc: async (name, parameters) => {
      calls.push({ name, parameters });
      return { data: { ignored: 7 }, error: null };
    },
  };

  const result = await ignoreExpiredUnstartedPublications(supabase, {
    now: Date.parse('2026-08-28T05:12:00.000Z'),
    cutoffDelayMs: 60_000,
    limit: 10,
  });

  assert.deepEqual(result, {
    ignored: 0,
    pages: 0,
    cutoff: '2026-08-28T05:11:00.000Z',
    failed: false,
    automaticDiscardDisabled: true,
  });
  assert.deepEqual(calls, []);
});

test('Data API indisponível não interfere porque limpeza automática não chama RPC', async () => {
  const supabase = { rpc: async () => ({ data: null, error: { code: 'PGRST002', message: 'Data API indisponível' } }) };
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await ignoreExpiredUnstartedPublications(supabase, {
      now: Date.parse('2026-08-28T05:12:00.000Z'),
    });
    assert.deepEqual(result, {
      ignored: 0,
      pages: 0,
      cutoff: '2026-08-28T05:11:00.000Z',
      failed: false,
      automaticDiscardDisabled: true,
    });
  } finally {
    console.error = originalError;
  }
});

test('limpeza automática permanece desativada mesmo com paginação configurada', async () => {
  let calls = 0;
  const supabase = {
    rpc: async (_name, parameters) => {
      calls += 1;
      assert.equal(parameters.p_limit, 10);
      return { data: { ignored: calls < 5 ? 10 : 4 }, error: null };
    },
  };

  const result = await ignoreExpiredUnstartedPublications(supabase, {
    now: Date.parse('2026-08-28T05:12:00.000Z'),
  });
  assert.equal(calls, 0);
  assert.equal(result.ignored, 0);
  assert.equal(result.pages, 0);
  assert.equal(result.failed, false);
  assert.equal(result.automaticDiscardDisabled, true);
});

test('preparação respeita concorrência máxima sem alterar a ordem dos resultados', async () => {
  let active = 0;
  let maximumActive = 0;
  const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (value) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    if (value === 4) throw new Error('falha isolada');
    return value * 2;
  });

  assert.equal(maximumActive, 2);
  assert.deepEqual(results.map((result) => result.status), [
    'fulfilled', 'fulfilled', 'fulfilled', 'rejected', 'fulfilled', 'fulfilled',
  ]);
  assert.equal(results[0].value, 2);
  assert.match(results[3].reason.message, /falha isolada/);
});

test('cancelamento cooperativo interrompe antes de novos itens, mas nunca aborta um item em andamento', async () => {
  // Concorrência 1 torna o teste determinístico: sem disputa entre workers, o único
  // worker sempre vê o shouldStop atualizado pelo item anterior antes de pegar o próximo.
  let shouldStop = false;
  const attempted = [];
  const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 1, async (value) => {
    attempted.push(value);
    if (value === 2) shouldStop = true;
    return value * 10;
  }, () => shouldStop);

  assert.deepEqual(attempted, [1, 2]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[0].value, 10);
  assert.equal(results[1].status, 'fulfilled');
  assert.equal(results[1].value, 20);
  assert.deepEqual(Array.from(results.slice(2)), [undefined, undefined, undefined, undefined]);
});

test('shouldStop ausente preserva o comportamento padrão (nunca para sozinho)', async () => {
  const results = await mapWithConcurrency([1, 2, 3], 1, async (value) => value);
  assert.deepEqual(results.map((entry) => entry.status), ['fulfilled', 'fulfilled', 'fulfilled']);
});

test('preparação Athena valida payload sem depender de URL ou chamada ao provedor', () => {
  const prepared = validatePreparedPublicationWorkItem({
    format: 'reel',
    profile: {
      provider: 'zernio',
      organization_id: 'org-1',
      zernio_account_id: 'account-1',
    },
    media: [{ id: 'media-1', kind: 'video', storage_path: 'org/video.mp4' }],
  });
  assert.deepEqual(prepared, { ready: true, provider: 'zernio', mediaCount: 1 });

  assert.throws(() => validatePreparedPublicationWorkItem({
    format: 'reel',
    profile: { provider: 'zernio', organization_id: 'org-1', zernio_account_id: 'account-1' },
    media: [{ id: 'media-1', kind: 'image', storage_path: 'org/image.jpg' }],
  }), /vídeo/i);
});

test('concorrência adaptativa reduz sob pressão e cresce quando a capacidade foi consumida', () => {
  assert.equal(nextAdaptiveDispatchLimit(20, 100, [{ state: 'failed', errorCode: 'http_429' }], 20), 10);
  assert.equal(nextAdaptiveDispatchLimit(10, 100, Array.from({ length: 10 }, () => ({ state: 'published' })), 10), 12);
  assert.equal(nextAdaptiveDispatchLimit(100, 100, [], 100), 100);
});

test('timeout interno do banco nunca vira falha terminal de publicação', () => {
  assert.equal(isPublicationInfrastructureError({ code: '57014', message: 'canceling statement due to statement timeout' }), true);
  assert.equal(isPublicationInfrastructureError({ code: '40001', message: 'serialization failure' }), true);
  assert.equal(isPublicationInfrastructureError(new TypeError("Cannot read properties of undefined (reading 'provider')")), true);
  assert.equal(isPublicationInfrastructureError({ code: 'platform_error', message: 'Instagram não baixou a mídia' }), false);
  assert.equal(isPublicationInfrastructureError({ code: '190', message: 'Token expirado' }), false);
});

test('classifica somente os sinais terminais aprovados da Zernio', () => {
  assert.equal(isZernioTerminalAccountDisconnection({ errorCode: 'ACCOUNT_DISCONNECTED' }), true);
  assert.equal(isZernioTerminalAccountDisconnection({ errorMessage: 'auth_expired retornado pela Zernio' }), true);
  assert.equal(isZernioTerminalAccountDisconnection({ providerDiagnostic: { providerCode: 'AUTH-EXPIRED' } }), true);
  assert.equal(isZernioTerminalAccountDisconnection({ errorCode: 'zernio_request_failed', errorMessage: 'timeout ao publicar' }), false);
  assert.equal(isZernioTerminalAccountDisconnection({ errorCode: 'account_disconnectedish' }), false);
});

test('classifica erro Meta 190 com login obrigatório como queda terminal do perfil', () => {
  assert.equal(isMetaTerminalProfileDisconnection({
    errorCode: '190',
    errorMessage: 'Error validating access token: You cannot access the app till you log in to www.instagram.com and follow the instructions given.',
  }), true);
  assert.equal(isMetaTerminalProfileDisconnection({
    errorCode: '190',
    providerDiagnostic: { errorSubcode: 458 },
  }), true);
  assert.equal(isMetaTerminalProfileDisconnection({
    errorCode: '190',
    errorMessage: 'Erro temporário sem sinal de invalidação.',
  }), false);
  assert.equal(isMetaTerminalProfileDisconnection({
    errorCode: '4',
    errorMessage: 'Application request limit reached',
  }), false);
});

test('classifica timeout, resposta HTTP, parse e rede para a telemetria Zernio', () => {
  assert.equal(zernioOutcome({ name: 'TimeoutError' }), 'timeout');
  assert.equal(zernioOutcome({ httpStatus: 429 }), 'http_error');
  assert.equal(zernioOutcome(new SyntaxError('JSON inválido')), 'parse_error');
  assert.equal(zernioOutcome(new Error('socket encerrado')), 'network_error');
});

test('timeout durante criação Zernio vira resultado desconhecido sem retry automático', () => {
  const error = Object.assign(new Error('The operation was aborted due to timeout'), {
    name: 'TimeoutError',
    zernioOperation: 'create_post',
  });
  const result = zernioFailureResult(error);

  assert.equal(result.state, 'failed');
  assert.equal(result.retryable, false);
  assert.equal(result.errorCode, 'zernio_creation_outcome_unknown');
});

test('timeout durante polling Zernio mantém retry porque consulta a mesma criação', () => {
  const error = Object.assign(new Error('The operation was aborted due to timeout'), {
    name: 'TimeoutError',
    zernioOperation: 'get_post',
  });
  const result = zernioFailureResult(error);

  assert.equal(result.state, 'failed');
  assert.equal(result.retryable, true);
  assert.notEqual(result.errorCode, 'zernio_creation_outcome_unknown');
});

test('HTTP 5xx durante criação Zernio também bloqueia recriação automática', () => {
  const error = Object.assign(new Error('Zernio retornou erro interno'), {
    httpStatus: 503,
    retryable: true,
    zernioOperation: 'create_post',
  });
  const result = zernioFailureResult(error);

  assert.equal(result.retryable, false);
  assert.equal(result.errorCode, 'zernio_creation_outcome_unknown');
});

test('HTTP 429 durante criação é rejeição conhecida e mantém retry com a mesma chave', () => {
  const error = Object.assign(new Error('Limite temporário'), {
    httpStatus: 429,
    retryable: true,
    zernioOperation: 'create_post',
  });
  const result = zernioFailureResult(error);

  assert.equal(result.retryable, true);
  assert.notEqual(result.errorCode, 'zernio_creation_outcome_unknown');
});

test('extrai existingPostId do erro estruturado de deduplicação Zernio', () => {
  assert.equal(zernioExistingPostId({ existingPostId: 'post-direto' }), 'post-direto');
  assert.equal(zernioExistingPostId({ details: { existingPostId: 'post-detalhes' } }), 'post-detalhes');
  assert.equal(zernioExistingPostId({ details: null }), null);
});

test('bloqueia item legado que exigiria uma segunda criação Zernio', () => {
  assert.equal(zernioWorkItemRequiresManualReconciliation({
    profile: { provider: 'zernio' },
    zernio_recovery_count: 1,
    creation_id: null,
  }), true);
  assert.equal(zernioWorkItemRequiresManualReconciliation({
    profile: { provider: 'zernio' },
    zernio_recovery_count: 1,
    creation_id: 'post-existente',
  }), false);
  assert.equal(zernioWorkItemRequiresManualReconciliation({
    profile: { provider: 'meta_official' },
    zernio_recovery_count: 1,
    creation_id: null,
  }), false);
});

test('remove URLs e tokens Bearer dos diagnósticos Zernio', () => {
  const sanitized = sanitizedZernioDiagnostic('Bearer segredo https://storage.example/arquivo.mp4?token=segredo');
  assert.match(sanitized, /Bearer \[oculto\]/);
  assert.match(sanitized, /\[URL ocultada\]/);
  assert.doesNotMatch(sanitized, /segredo|storage\.example/);
});

test('envia rollups e anomalias Zernio sem carregar conteúdo sensível', async () => {
  recordZernioRequestTelemetry({
    organizationId: 'org-telemetry',
    connectionId: 'connection-telemetry',
    itemId: 'item-telemetry',
    batchId: 'batch-telemetry',
    correlationId: 'correlation-telemetry',
    operation: 'create_post',
    attemptCount: 2,
  }, 'timeout', 25_001, Object.assign(new Error('Bearer segredo https://storage.example/video.mp4?token=segredo'), {
    name: 'TimeoutError',
    requestId: 'request-telemetry',
  }));

  const calls = [];
  const result = await flushZernioRequestTelemetry({
    createSupabase: () => ({
      async rpc(name, payload) {
        calls.push({ name, payload });
        return { error: null };
      },
    }),
  });

  assert.deepEqual(result, { flushed: 1, anomalies: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'record_zernio_publication_request_telemetry');
  assert.equal(calls[0].payload.p_rollups[0].outcome, 'timeout');
  assert.equal(calls[0].payload.p_rollups[0].latency_histogram['15s_timeout'], 1);
  assert.equal(calls[0].payload.p_anomalies[0].error_message.includes('segredo'), false);
  assert.equal(calls[0].payload.p_anomalies[0].error_message.includes('storage.example'), false);
});

test('normaliza operação Zernio ausente sem descartar o lote de telemetria', async () => {
  recordZernioRequestTelemetry({ organizationId: 'org-operation-null' }, 'succeeded', 20);
  const calls = [];
  const result = await flushZernioRequestTelemetry({
    createSupabase: () => ({
      async rpc(name, payload) {
        calls.push({ name, payload });
        return { error: null };
      },
    }),
  });

  assert.equal(result.flushed, 1);
  assert.equal(calls[0].payload.p_rollups[0].operation, 'unknown');
});

test('descarta falha de persistência da telemetria sem propagá-la à fila', async () => {
  recordZernioRequestTelemetry({ organizationId: 'org-telemetry', operation: 'get_post' }, 'succeeded', 100);
  const result = await flushZernioRequestTelemetry({
    createSupabase: () => ({
      async rpc() { return { error: new Error('Banco indisponível') }; },
    }),
  });

  assert.deepEqual(result, { flushed: 0, anomalies: 0, discarded: 1, discardedAnomalies: 0 });
});

function queryResult(result) {
  const chain = {
    select() { return chain; },
    eq() { return chain; },
    is() { return chain; },
    order() { return Promise.resolve(result); },
    maybeSingle() { return Promise.resolve(result); },
  };
  return chain;
}

function clientFor(profile) {
  return {
    from(table) {
      if (table === 'instagram_profiles') return queryResult({ data: profile, error: null });
      if (table === 'publication_item_media') return queryResult({ data: [], error: null });
      if (table === 'publication_items') return queryResult({ data: {
        container_poll_count: 0,
        provider_creation_started_at: null,
        zernio_recovery_count: 0,
        zernio_recovery_poll_at: null,
      }, error: null });
      throw new Error(`Tabela inesperada: ${table}`);
    },
  };
}

test('revalida perfil offline antes de acessar provedor ou mídia', async () => {
  const result = await loadWorkItem({
    id: 'item-1',
    profile_id: 'profile-1',
    organization_id: 'org-1',
  }, {
    createSupabase: () => clientFor({
      id: 'profile-1', organization_id: 'org-1', provider: 'meta_official', status: 'offline',
    }),
  });

  assert.deepEqual(result, {
    state: 'suspended',
    retryable: false,
    errorCode: 'profile_offline_suspended',
    errorMessage: 'Perfil offline; retomada manual necessária.',
  });
});

test('perfil online continua no fluxo normal de validação', async () => {
  const result = await loadWorkItem({
    id: 'item-2',
    profile_id: 'profile-2',
    organization_id: 'org-1',
    format: 'image',
    caption: null,
    creation_id: null,
  }, {
    createSupabase: () => clientFor({
      id: 'profile-2', organization_id: 'org-1', provider: 'meta_official', status: 'online',
    }),
  });

  assert.equal(result.profile.status, 'online');
  assert.deepEqual(result.media, []);
});

test('barreira pré-provedor usa RPC transacional e respeita perfil suspenso', async () => {
  const calls = [];
  const result = await claimedProfileRemainsOnline({ id: 'item-3' }, 'worker-3', {
    createSupabase: () => ({
      async rpc(name, payload) {
        calls.push({ name, payload });
        return { data: false, error: null };
      },
    }),
  });

  assert.equal(result, false);
  assert.deepEqual(calls, [{
    name: 'assert_claimed_publication_profile_online',
    payload: { p_item_id: 'item-3', p_worker_id: 'worker-3' },
  }]);
});

test('reconcilia confirmação externa sem depender do claim já removido', async () => {
  const calls = [];
  const result = await preserveConfirmedPublication('item-4', 'worker-4', 'media-4', {
    createSupabase: () => ({
      async rpc(name, payload) {
        calls.push({ name, payload });
        return { data: { status: 'published' }, error: null };
      },
    }),
  });

  assert.deepEqual(result, { status: 'published' });
  assert.deepEqual(calls, [{
    name: 'reconcile_confirmed_publication_item',
    payload: { p_item_id: 'item-4', p_worker_id: 'worker-4', p_meta_media_id: 'media-4' },
  }]);
});

test('persiste criação e confirmação recuperadas da Zernio', async () => {
  const calls = [];
  const result = await preserveReconciledZernioPublication('item-z', 'worker-z', 'post-z', 'media-z', {
    createSupabase: () => ({
      async rpc(name, payload) {
        calls.push({ name, payload });
        return { data: { status: 'published', creationId: 'post-z' }, error: null };
      },
    }),
  });

  assert.equal(result.status, 'published');
  assert.deepEqual(calls, [{
    name: 'reconcile_zernio_publication_item',
    payload: {
      p_item_id: 'item-z',
      p_worker_id: 'worker-z',
      p_creation_id: 'post-z',
      p_meta_media_id: 'media-z',
    },
  }]);
});

test('preserva criação aceita pelo provedor quando item já foi suspenso', async () => {
  const calls = [];
  const result = await preserveAcceptedProviderCreation('item-5', 'worker-5', 'creation-5', {
    createSupabase: () => ({
      async rpc(name, payload) {
        calls.push({ name, payload });
        return { data: { status: 'suspended', creationId: 'creation-5' }, error: null };
      },
    }),
  });

  assert.deepEqual(result, { status: 'suspended', creationId: 'creation-5' });
  assert.deepEqual(calls, [{
    name: 'reconcile_suspended_publication_creation',
    payload: { p_item_id: 'item-5', p_worker_id: 'worker-5', p_creation_id: 'creation-5' },
  }]);
});

test('sonda vídeo com HEAD e GET Range real sem expor a URL no resultado', async () => {
  const url = 'https://storage.example/video.mp4?token=segredo';
  const calls = [];
  const result = await probeMediaUrl(url, 'video', {
    fetch: async (_input, init) => {
      calls.push(init);
      if (init.method === 'HEAD') {
        return new Response(null, { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '1024' } });
      }
      assert.equal(init.headers.Range, 'bytes=0-1023');
      return new Response('x', { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-1023/1024' } });
    },
  });

  assert.equal(result.httpStatus, 206);
  assert.equal(result.contentType, 'video/mp4');
  assert.equal(result.contentLength, 1024);
  assert.equal(calls.length, 2);
  assert.equal(result.fingerprint, urlFingerprint(url));
  assert.notEqual(result.fingerprint, url);
});

test('snapshot antecipado não publica perfil que caiu e devolve a tentativa ao fluxo suspenso', async () => {
  const calls = [];
  const allowed = await ensureClaimedProfileOnlineOrSuspend({ id: 'item-staged' }, 'worker-staged', {
    claimedProfileRemainsOnline: async () => false,
    suspendClaimedPublication: async (item, workerId, reason) => calls.push({ item, workerId, reason }),
  });
  assert.equal(allowed, false);
  assert.deepEqual(calls, [{
    item: { id: 'item-staged' },
    workerId: 'worker-staged',
    reason: 'Perfil offline; retomada manual necessária.',
  }]);
});

test('usa GET parcial quando HEAD não retorna tipo de mídia válido', async () => {
  const calls = [];
  const result = await probeMediaUrl('https://storage.example/image.jpg?token=segredo', 'image', {
    fetch: async (_input, init) => {
      calls.push(init);
      if (init.method === 'HEAD') return new Response(null, { status: 405 });
      return new Response('x', { status: 206, headers: { 'content-type': 'image/jpeg' } });
    },
  });

  assert.equal(result.httpStatus, 206);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers.Range, 'bytes=0-1023');
});

test('não entrega URL ao provedor quando a sonda de mídia falha e registra a tentativa', async () => {
  const attempts = [];
  await assert.rejects(() => buildVerifiedMediaUrls({
    id: 'item-media-1',
    profile: { provider: 'zernio' },
    media: [{ id: 'asset-1', storage_path: 'org/asset.mp4', kind: 'video' }],
  }, {
    createTemporaryUrl: async () => 'https://storage.example/asset.mp4?token=segredo',
    probeMediaUrl: async () => { throw Object.assign(new Error('Objeto indisponível.'), { code: 'media_url_probe_http_404' }); },
    recordMediaDeliveryAttempt: async (...args) => attempts.push(args),
  }), /Objeto indisponível/);

  assert.equal(attempts.length, 1);
  assert.deepEqual(attempts[0].slice(2, 4), ['url_probe', 'failed']);
  assert.equal(attempts[0][4].errorCode, 'media_url_probe_http_404');
  assert.equal(attempts[0][4].urlFingerprint, urlFingerprint('https://storage.example/asset.mp4?token=segredo'));
});

test('quinhentos itens Zernio recebem URL direta fresca sem hospedagem antecipada', async () => {
  let signedUrls = 0;
  let probes = 0;
  const results = await Promise.all(Array.from({ length: 500 }, async (_, index) => {
    const item = {
      id: `item-direct-${index}`,
      media: [{ id: 'asset-shared', storage_path: 'org/shared.mp4', kind: 'video' }],
    };
    return buildZernioMediaItems(item, {
      createTemporaryUrl: async () => {
        signedUrls += 1;
        return `https://storage.example/org/shared.mp4?token=${index}`;
      },
      probeMediaUrl: async (url) => {
        probes += 1;
        return { url, fingerprint: urlFingerprint(url), httpStatus: 206, contentType: 'video/mp4' };
      },
      recordMediaDeliveryAttempt: async () => undefined,
    });
  }));

  assert.equal(signedUrls, 500);
  assert.equal(probes, 500);
  assert.equal(new Set(results.map((mediaItems) => mediaItems[0].url)).size, 500);
  assert.ok(results.every((mediaItems) => mediaItems[0].url.startsWith('https://storage.example/')));
  assert.ok(results.every((mediaItems) => !mediaItems[0].url.includes('athena_publication=')));
});

test('agenda polls Zernio em +1, +3, +6 de recuperação e +10 final sem bloquear worker', () => {
  const startedAt = Date.parse('2026-08-15T06:00:00.000Z');
  assert.equal(zernioPollingDelaySeconds({ creation_id: null, zernio_recovery_count: 0 }, startedAt), 60);
  assert.equal(zernioPollingDelaySeconds({ creation_id: 'original', container_poll_count: 0 }, startedAt + 60_000), 120);
  assert.equal(zernioPollingDelaySeconds({
    creation_id: 'original',
    container_poll_count: 1,
    provider_creation_started_at: '2026-08-15T06:00:00.000Z',
  }, startedAt + 180_000), 420);
  assert.equal(zernioPollingDelaySeconds({
    creation_id: 'replacement',
    zernio_recovery_count: 1,
    zernio_recovery_poll_at: '2026-08-15T06:06:00.000Z',
  }, startedAt + 180_000), 180);
});

test('agenda recuperação Zernio usando as mídias carregadas do work item', async () => {
  const calls = [];
  const fingerprintCalls = [];
  const workItem = {
    id: 'item-zernio-recovery',
    creation_id: 'creation-zernio-failed',
    media: [{ id: 'asset-video', storage_path: 'org/video.mp4', kind: 'video' }],
  };

  const scheduled = await scheduleZernioMediaDownloadRecovery(workItem, 'worker-zernio', {
    errorCode: 'platform_error',
    errorMessage: 'Instagram could not download the video.',
  }, {
    latestProviderUrlFingerprint: async (receivedItem, media) => {
      fingerprintCalls.push({ receivedItem, media });
      return 'fingerprint-video';
    },
    createSupabase: () => ({
      async rpc(name, payload) {
        calls.push({ name, payload });
        return { data: { scheduled: true }, error: null };
      },
    }),
  });

  assert.equal(scheduled, true);
  assert.deepEqual(fingerprintCalls, [{ receivedItem: workItem, media: workItem.media[0] }]);
  assert.deepEqual(calls, [{
    name: 'schedule_zernio_media_download_recovery',
    payload: {
      p_item_id: 'item-zernio-recovery',
      p_worker_id: 'worker-zernio',
      p_creation_id: 'creation-zernio-failed',
      p_error_code: 'platform_error',
      p_error_message: 'Instagram could not download the video.',
      p_url_fingerprint: 'fingerprint-video',
    },
  }]);
});

test('primeira falha de download Zernio agenda segundo poll sem recriar o post', async () => {
  const calls = [];
  const workItem = {
    id: 'item-first-download-failure',
    creation_id: 'creation-still-under-observation',
    container_poll_count: 0,
    zernio_recovery_count: 0,
  };

  await deferFirstZernioMediaDownloadFailure(workItem, 'worker-second-poll', {
    createSupabase: () => ({
      async rpc(name, payload) {
        calls.push({ name, payload });
        return { data: [{ status: 'waiting' }], error: null };
      },
    }),
  });

  assert.deepEqual(calls, [{
    name: 'defer_publication_item',
    payload: {
      p_item_id: 'item-first-download-failure',
      p_worker_id: 'worker-second-poll',
      p_creation_id: 'creation-still-under-observation',
      p_delay_seconds: 120,
      p_is_poll: true,
    },
  }]);
});

test('recupera download atualizando e repetindo o mesmo post Zernio', async () => {
  const rpcCalls = [];
  const providerCalls = [];
  const supabase = {
    async rpc(name, payload) {
      rpcCalls.push({ name, payload });
      if (name === 'reserve_zernio_same_post_media_retry') return { data: { reserved: true }, error: null };
      throw new Error(`RPC inesperado: ${name}`);
    },
  };
  const client = {
    async updatePost(postId, body) {
      providerCalls.push({ operation: 'update', postId, body });
      return {};
    },
    async retryPost(postId) {
      providerCalls.push({ operation: 'retry', postId });
      return { post: { _id: postId, status: 'processing', platforms: [{ platform: 'instagram', status: 'processing' }] } };
    },
  };
  const workItem = {
    id: 'item-same-post',
    batch_id: 'batch-1',
    creation_id: 'post-original',
    execute_at: new Date().toISOString(),
    attempt_count: 2,
    profile: { organization_id: 'org-1', provider: 'zernio' },
    media: [{ id: 'asset-1', storage_path: 'org/video.mp4', kind: 'video' }],
  };

  const recovery = await retryZernioMediaDownloadOnSamePost(workItem, 'worker-same-post', {
    errorCode: 'platform_error',
    errorMessage: 'Instagram could not download the video.',
  }, {
    createSupabase: () => supabase,
    client,
    createTemporaryUrl: async () => 'https://storage.example/org/video.mp4?token=fresco',
    probeMediaUrl: async (url) => ({ url, fingerprint: urlFingerprint(url), httpStatus: 206, contentType: 'video/mp4' }),
    recordMediaDeliveryAttempt: async () => undefined,
  });

  assert.equal(recovery.started, true);
  assert.equal(recovery.result.state, 'processing');
  assert.deepEqual(providerCalls.map((call) => call.operation), ['update', 'retry']);
  assert.ok(providerCalls.every((call) => call.postId === 'post-original'));
  assert.equal(providerCalls[0].body.mediaItems[0].url, 'https://storage.example/org/video.mp4?token=fresco');
  assert.equal(rpcCalls.filter((call) => call.name === 'reserve_zernio_same_post_media_retry').length, 1);
});

// MEDIDO EM PRODUCAO (30/08/2026): 6.777 requisicoes a Zernio em 2h, 44 falhas
// (0,5%). A versao anterior ligava backpressure de 5 MINUTOS a cada uma delas, e
// backpressure derruba o teto de criacao de 800/min para 300/min. Com uma falha
// a cada 2,7 min, o teto vivia na metade por causa de erro transitorio normal.
test('429 liga o backpressure na hora, sem precisar se repetir', () => {
  // O provedor disse explicitamente "pare". Nao se conta, nao se negocia.
  assert.equal(shouldActivateZernioBackpressure({ httpStatus: 429 }, 0, 3), true);
  assert.equal(shouldActivateZernioBackpressure({ httpStatus: 429 }, 99, 3), true);
});

test('falha transitoria isolada NAO liga o backpressure', () => {
  const timeout = { name: 'TimeoutError' };
  const rede = new Error('socket hang up');
  const servidor = { httpStatus: 503 };
  assert.equal(shouldActivateZernioBackpressure(timeout, 1, 3), false);
  assert.equal(shouldActivateZernioBackpressure(rede, 2, 3), false);
  assert.equal(shouldActivateZernioBackpressure(servidor, 1, 3), false);
});

test('falha transitoria repetida dentro da janela liga', () => {
  // Problema continuo continua sendo tratado como problema: a janela reenche e
  // o backpressure se renova, acompanhando a TAXA de erro.
  assert.equal(shouldActivateZernioBackpressure({ name: 'TimeoutError' }, 3, 3), true);
  assert.equal(shouldActivateZernioBackpressure(new Error('ECONNRESET'), 10, 3), true);
});

test('erro do cliente (4xx que nao seja 429) nunca liga backpressure', () => {
  // 400/404 sao problema do nosso payload, nao do provedor sobrecarregado.
  // Reduzir a vazao global por causa deles seria punir todo mundo por um item.
  assert.equal(shouldActivateZernioBackpressure({ httpStatus: 400 }, 99, 3), false);
  assert.equal(shouldActivateZernioBackpressure({ httpStatus: 404 }, 99, 3), false);
});

test('sucesso nao liga nada', () => {
  assert.equal(shouldActivateZernioBackpressure(null, 99, 3), false);
});

// PROVA MEDIDA (30/08/2026): com a regra antiga (metade a cada UM erro), e a taxa
// de erro real da Zernio em ~1%, o controlador convergia matematicamente para ~23
// itens por ciclo e nao passava disso - independente da capacidade. Bate com o
// medido: `used: 30`, ciclos de 9 a 16, e 64 vagas de concorrencia ociosas.
test('erro de rede isolado num lote grande NAO derruba o limite pela metade', () => {
  // 1 timeout em 50 itens = 2% do lote, abaixo do limiar de 10%. Segura, nao cai.
  const lote = Array.from({ length: 50 }, (_, i) => (
    i === 0 ? { state: 'failed', error: 'network timeout' } : { state: 'published' }
  ));
  assert.equal(nextAdaptiveDispatchLimit(50, 100, lote, 50), 50);
});

test('erro de rede em fracao relevante do lote derruba pela metade', () => {
  // 6 de 50 = 12%, acima do limiar. Isso e problema de verdade.
  const lote = Array.from({ length: 50 }, (_, i) => (
    i < 6 ? { state: 'failed', error: 'network error' } : { state: 'published' }
  ));
  assert.equal(nextAdaptiveDispatchLimit(50, 100, lote, 50), 25);
});

test('429 continua derrubando na hora, mesmo sozinho num lote grande', () => {
  // O provedor disse explicitamente "pare". Nao entra na conta de fracao.
  const lote = Array.from({ length: 50 }, (_, i) => (
    i === 0 ? { state: 'failed', errorCode: 'http_429' } : { state: 'published' }
  ));
  assert.equal(nextAdaptiveDispatchLimit(50, 100, lote, 50), 25);
});

test('lote limpo continua crescendo 20%', () => {
  const lote = Array.from({ length: 50 }, () => ({ state: 'published' }));
  assert.equal(nextAdaptiveDispatchLimit(50, 100, lote, 50), 60);
});
