import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bulkGenerationIsEnabled,
  claimBulkChunks,
  failBulkChunk,
  loadBulkSummary,
  processBulkChunk,
  processClaimedBulkChunk,
} from './publication-generation-worker.mjs';

test('flag compacta pausa somente valores explicitamente false', () => {
  assert.equal(bulkGenerationIsEnabled(undefined), true);
  assert.equal(bulkGenerationIsEnabled('true'), true);
  assert.equal(bulkGenerationIsEnabled(' false '), false);
  assert.equal(bulkGenerationIsEnabled('FALSE'), false);
});

function rpcClient(handler) {
  return {
    rpc(name, parameters) {
      return Promise.resolve(handler(name, parameters));
    },
  };
}

test('usa contratos compactos com limites conservadores', async () => {
  const calls = [];
  const supabase = rpcClient((name, parameters) => {
    calls.push({ name, parameters });
    if (name === 'get_bulk_rotation_worker_summary') {
      return { data: { activePlans: '2', remainingPublications: '900' }, error: null };
    }
    if (name === 'claim_bulk_rotation_generation_chunks') {
      return { data: [{ id: 'chunk-1' }], error: null };
    }
    if (name === 'process_bulk_rotation_generation_chunk') {
      return { data: { processedItems: '500', status: 'queued' }, error: null };
    }
    return { data: null, error: new Error(`RPC inesperada: ${name}`) };
  });

  assert.deepEqual(await loadBulkSummary(supabase), {
    activePlans: '2',
    remainingPublications: '900',
  });
  assert.deepEqual(await claimBulkChunks(supabase), [{ id: 'chunk-1' }]);
  assert.deepEqual(await processBulkChunk(supabase, { id: 'chunk-1' }), {
    processedItems: '500',
    status: 'queued',
  });

  assert.equal(calls[1].parameters.p_limit, 1);
  assert.equal(calls[1].parameters.p_lease_seconds, 300);
  assert.equal(calls[1].parameters.p_max_failures, 3);
  assert.equal(calls[2].parameters.p_step_size, 500);
});

test('registra falha de um chunk compacto sem propagar para os demais', async () => {
  const calls = [];
  const supabase = rpcClient((name, parameters) => {
    calls.push({ name, parameters });
    if (name === 'process_bulk_rotation_generation_chunk') {
      return { data: null, error: new Error('falha simulada') };
    }
    if (name === 'fail_bulk_rotation_generation_chunk') {
      return {
        data: { status: 'failed', consecutiveFailures: 1, retryExhausted: false },
        error: null,
      };
    }
    return { data: null, error: new Error(`RPC inesperada: ${name}`) };
  });

  const result = await processClaimedBulkChunk(supabase, {
    id: 'chunk-com-falha',
    plan_id: 'plan-1',
  });

  assert.equal(result.ok, false);
  assert.equal(result.message, 'falha simulada');
  assert.equal(result.failure.retryExhausted, false);
  assert.equal(calls[1].name, 'fail_bulk_rotation_generation_chunk');
  assert.equal(calls[1].parameters.p_chunk_id, 'chunk-com-falha');
  assert.equal(calls[1].parameters.p_error_message, 'falha simulada');
});

test('expõe erro de liberação mantendo isolamento do ciclo', async () => {
  const supabase = rpcClient((name) => {
    if (name === 'process_bulk_rotation_generation_chunk') {
      return { data: null, error: new Error('processamento indisponível') };
    }
    return { data: null, error: new Error('lease já expirou') };
  });

  const result = await processClaimedBulkChunk(supabase, {
    id: 'chunk-sem-lease',
    plan_id: 'plan-2',
  });

  assert.equal(result.ok, false);
  assert.equal(result.message, 'processamento indisponível');
  assert.equal(result.failureRegistrationError, 'lease já expirou');
});

test('falha compacta envia mensagem e limite ao RPC de retry', async () => {
  let captured;
  const supabase = rpcClient((name, parameters) => {
    captured = { name, parameters };
    return { data: { retryExhausted: true }, error: null };
  });

  assert.deepEqual(await failBulkChunk(supabase, { id: 'chunk-3' }, 'erro final'), {
    retryExhausted: true,
  });
  assert.equal(captured.name, 'fail_bulk_rotation_generation_chunk');
  assert.equal(captured.parameters.p_max_failures, 3);
});

test('preserva mensagem de erro estruturado retornado pelo Supabase', async () => {
  const supabase = rpcClient((name) => {
    if (name === 'process_bulk_rotation_generation_chunk') {
      return { data: null, error: { code: 'PGRST202', message: 'RPC ausente no cache' } };
    }
    return { data: { retryExhausted: false }, error: null };
  });

  const result = await processClaimedBulkChunk(supabase, {
    id: 'chunk-erro-estruturado',
    plan_id: 'plan-3',
  });

  assert.equal(result.ok, false);
  assert.equal(result.message, 'RPC ausente no cache');
});
