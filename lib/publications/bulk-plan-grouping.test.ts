import assert from 'node:assert/strict';
import test from 'node:test';

import { groupOfBulkPlan } from './bulk-plan-grouping.ts';

// O caso que motivou a separação em blocos é o 'waiting': antes, um plano
// confirmado mas ainda não iniciado tinha exatamente a mesma aparência de um
// plano gerando, então o usuário não sabia que havia algo esperando na fila e
// reagendava por cima — foi assim que o incidente de 29/08 escalou.

test('plano confirmado que ainda não começou fica em "na fila"', () => {
  assert.equal(groupOfBulkPlan({ status: 'queued', generatedPublications: '0' }), 'waiting');
});

test('plano já reivindicado mas sem nenhuma publicação criada continua em "na fila"', () => {
  assert.equal(groupOfBulkPlan({ status: 'generating', generatedPublications: '0' }), 'waiting');
});

test('plano produzindo publicações fica em "gerando agora"', () => {
  assert.equal(groupOfBulkPlan({ status: 'generating', generatedPublications: '1' }), 'running');
});

test('plano terminado fica em "concluídas", com ou sem avisos', () => {
  assert.equal(groupOfBulkPlan({ status: 'completed', generatedPublications: '720' }), 'finished');
  assert.equal(groupOfBulkPlan({ status: 'completed_with_errors', generatedPublications: '700' }), 'finished');
});

test('plano pausado ou com falha pede atenção, mesmo sem nada gerado', () => {
  assert.equal(groupOfBulkPlan({ status: 'paused', generatedPublications: '0' }), 'attention');
  assert.equal(groupOfBulkPlan({ status: 'failed', generatedPublications: '0' }), 'attention');
});

test('plano cancelado não polui o painel', () => {
  assert.equal(groupOfBulkPlan({ status: 'cancelled', generatedPublications: '0' }), 'hidden');
});
