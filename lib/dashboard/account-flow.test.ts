import assert from 'node:assert/strict';
import test from 'node:test';

import { accountFlowFallRate, accountFlowReasonCode, accountFlowReasonLabel, mergeAccountFlowReasons, mergeDayReasons } from './account-flow.ts';

test('nomeia os motivos vistos em produção', () => {
  assert.equal(accountFlowReasonLabel({ source: 'meta', signal: 'checkpoint_required', code: '190' }), 'Checkpoint');
  assert.equal(accountFlowReasonLabel({ source: 'meta', signal: 'checkpoint_required', code: '25' }), 'Acesso restrito');
  assert.equal(accountFlowReasonLabel({ source: 'meta', signal: 'checkpoint_required', code: '100' }), 'Conta não responde');
  assert.equal(accountFlowReasonLabel({ source: 'meta', signal: 'operator_requested', code: null }), 'Removida pelo operador');
  assert.equal(accountFlowReasonLabel({ source: 'zernio', signal: 'auth_expired', code: null }), 'Zernio: autorização expirada');
});

test('código desconhecido não ganha nome inventado', () => {
  assert.equal(accountFlowReasonLabel({ source: 'meta', signal: 'checkpoint_required', code: '368' }), 'Erro 368');
  assert.equal(accountFlowReasonLabel({ source: 'meta', signal: 'checkpoint_required', code: null }), 'Queda sem código');
});

test('selo do código junta o subcódigo e ignora o zero', () => {
  assert.equal(accountFlowReasonCode({ source: 'meta', code: '190', subcode: '0' }), '190');
  assert.equal(accountFlowReasonCode({ source: 'meta', code: '25', subcode: '2207050' }), '25 · 2207050');
  assert.equal(accountFlowReasonCode({ source: 'meta', code: null, subcode: null }), null);
  assert.equal(accountFlowReasonCode({ source: 'zernio', code: null, subcode: null }), 'Zernio');
});

test('taxa de queda não existe sem plugada', () => {
  assert.equal(accountFlowFallRate(0, 70), null);
  assert.equal(accountFlowFallRate(100, 70), 70);
  assert.equal(accountFlowFallRate(139, 430)?.toFixed(0), '309');
});

test('o mesmo motivo com subcódigo vazio ou zero, ou Zernio com códigos diferentes, vira uma linha só', () => {
  const base = { is_fall: true, sample_message: null };
  const { reasons, groupOf } = mergeAccountFlowReasons([
    { ...base, key: 'meta:checkpoint_required:190:0', source: 'meta', signal: 'checkpoint_required', code: '190', subcode: '0', total: 5033, last_at: '2026-10-14T10:00:00Z', sample_message: 'nova' },
    { ...base, key: 'meta:checkpoint_required:190:', source: 'meta', signal: 'checkpoint_required', code: '190', subcode: null, total: 16, last_at: '2026-09-04T10:00:00Z', sample_message: 'velha' },
    { ...base, key: 'meta:checkpoint_required:25:2207050', source: 'meta', signal: 'checkpoint_required', code: '25', subcode: '2207050', total: 2, last_at: '2026-10-02T10:00:00Z' },
    { ...base, key: 'zernio:account_disconnected:a::', source: 'zernio', signal: 'account_disconnected', code: 'a', subcode: null, total: 489, last_at: '2026-09-03T10:00:00Z' },
    { ...base, key: 'zernio:account_disconnected:b::', source: 'zernio', signal: 'account_disconnected', code: 'b', subcode: null, total: 9, last_at: '2026-09-02T10:00:00Z' },
  ]);
  assert.deepEqual(reasons.map((reason) => [accountFlowReasonLabel(reason), reason.total]), [
    ['Checkpoint', 5049],
    ['Zernio: conta desconectada', 498],
    ['Acesso restrito', 2],
  ]);
  assert.equal(reasons[0].sample_message, 'nova');
  assert.deepEqual(mergeDayReasons({ 'meta:checkpoint_required:190:0': 100, 'meta:checkpoint_required:190:': 2, 'zernio:account_disconnected:b::': 1 }, groupOf), [
    ['meta:checkpoint_required:190:', 102],
    ['zernio:account_disconnected', 1],
  ]);
});
