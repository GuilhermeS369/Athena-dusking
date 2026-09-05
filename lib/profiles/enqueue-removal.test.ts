import assert from 'node:assert/strict';
import test from 'node:test';

import { enqueueProfileRemovalInChunks, type RemovalRpcError } from './enqueue-removal.ts';
import type { ProfileRemovalRow } from './bulk-removal.ts';

function ids(count: number) {
  return Array.from({ length: count }, (_, index) => `profile-${index + 1}`);
}

function queuedRows(chunk: string[]): ProfileRemovalRow[] {
  return chunk.map((id) => ({ removed_profile_id: id, removed_username: id, removed_outcome: 'queued' }));
}

const TIMEOUT: RemovalRpcError = { code: '57014', message: 'canceling statement due to statement timeout' };

test('fatia o conjunto e devolve todas as linhas quando tudo passa', async () => {
  const calls: string[][] = [];
  const outcome = await enqueueProfileRemovalInChunks(async (chunk) => {
    calls.push(chunk);
    return { data: queuedRows(chunk), error: null };
  }, { profileIds: ids(50), pendingItemCount: 0 });

  // Sem itens abertos a fatia bate no teto de MAX_PROFILES_PER_REMOVAL_CALL (25).
  assert.deepEqual(calls.map((chunk) => chunk.length), [25, 25]);
  assert.equal(outcome.rows.length, 50);
  assert.deepEqual(outcome.remaining, []);
  assert.equal(outcome.splits, 0);
  assert.equal(outcome.error, null);
});

test('parte a fatia ao meio quando o banco devolve erro de infraestrutura', async () => {
  const attempted: number[] = [];
  let failedOnce = false;
  const outcome = await enqueueProfileRemovalInChunks(async (chunk) => {
    attempted.push(chunk.length);
    // A primeira fatia grande estoura; as metades passam.
    if (!failedOnce && chunk.length > 1) {
      failedOnce = true;
      return { data: null, error: TIMEOUT };
    }
    return { data: queuedRows(chunk), error: null };
  }, { profileIds: ids(4), pendingItemCount: 0 });

  assert.equal(outcome.splits, 1);
  assert.deepEqual(attempted, [4, 2, 2]);
  assert.equal(outcome.rows.length, 4);
  assert.equal(outcome.error, null);
});

test('um perfil sozinho que estoura é falha de verdade, não fatia grande demais', async () => {
  const outcome = await enqueueProfileRemovalInChunks(
    async () => ({ data: null, error: TIMEOUT }),
    { profileIds: ['profile-1'], pendingItemCount: 0 },
  );

  assert.equal(outcome.splits, 0);
  assert.equal(outcome.error?.code, '57014');
  assert.deepEqual(outcome.remaining, ['profile-1']);
});

test('erro não-recuperável interrompe e devolve o restante para continuação', async () => {
  const denied: RemovalRpcError = { code: '42501', message: 'Ação não permitida.' };
  let call = 0;
  const outcome = await enqueueProfileRemovalInChunks(async (chunk) => {
    call += 1;
    if (call === 1) return { data: queuedRows(chunk), error: null };
    return { data: null, error: denied };
  }, { profileIds: ids(50), pendingItemCount: 0 });

  assert.equal(outcome.error?.code, '42501');
  assert.equal(outcome.rows.length, 25, 'o que passou antes da falha é preservado');
  assert.equal(outcome.remaining.length, 25, 'o restante volta para quem chamou repetir');
  assert.equal(outcome.splits, 0);
});

test('o orçamento de parede devolve `remaining` em vez de estourar a rota', async () => {
  let clock = 0;
  const outcome = await enqueueProfileRemovalInChunks(async (chunk) => {
    clock += 30_000;
    return { data: queuedRows(chunk), error: null };
  }, { profileIds: ids(100), pendingItemCount: 0, budgetMs: 45_000, now: () => clock });

  // O orçamento é conferido no TOPO do laço, com o relógio de antes da fatia:
  // duas fatias de 30s rodam (a 2a começa em 30s, ainda dentro dos 45s) e a 3a
  // é barrada. Uma fatia pode ultrapassar o orçamento — é de propósito, o teto
  // real é o maxDuration de 60s da rota, e os 45s são a folga contra ele.
  assert.equal(outcome.rows.length, 50);
  assert.equal(outcome.remaining.length, 50);
  assert.equal(outcome.error, null);
});

test('a primeira fatia roda mesmo com o orçamento já vencido', async () => {
  let clock = 0;
  const outcome = await enqueueProfileRemovalInChunks(async (chunk) => {
    clock += 999_999;
    return { data: queuedRows(chunk), error: null };
  }, { profileIds: ids(10), pendingItemCount: 0, budgetMs: 1, now: () => clock });

  assert.equal(outcome.rows.length, 10, 'dez perfis cabem numa fatia só');
  assert.deepEqual(outcome.remaining, []);
});

test('conjunto vazio não chama o banco', async () => {
  let called = false;
  const outcome = await enqueueProfileRemovalInChunks(async () => {
    called = true;
    return { data: [], error: null };
  }, { profileIds: [], pendingItemCount: 0 });

  assert.equal(called, false);
  assert.deepEqual(outcome.rows, []);
  assert.equal(outcome.error, null);
});

test('muitos itens abertos encolhem a fatia', async () => {
  const calls: number[] = [];
  await enqueueProfileRemovalInChunks(async (chunk) => {
    calls.push(chunk.length);
    return { data: queuedRows(chunk), error: null };
  }, { profileIds: ids(20), pendingItemCount: 20 * 100 });

  // 100 itens por perfil contra o orçamento de 400 itens por chamada: 4 perfis.
  assert.deepEqual(calls, [4, 4, 4, 4, 4]);
});
