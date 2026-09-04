import assert from 'node:assert/strict';
import test from 'node:test';

import {
  META_TOKEN_ALARM_AFTER_DAYS,
  META_TOKEN_REFRESH_AFTER_DAYS,
  metaTokenRenewalLabel,
  metaTokenRenewalState,
  summarizeMetaTokenFleet,
  type MetaTokenProfile,
} from './meta-token-renewal.ts';

const NOW = Date.parse('2026-09-04T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function profile(overrides: Partial<MetaTokenProfile> = {}): MetaTokenProfile {
  return {
    provider: 'meta_official',
    token_refreshed_at: new Date(NOW - 2 * DAY).toISOString(),
    token_expires_at: new Date(NOW + 58 * DAY).toISOString(),
    token_refresh_attempted_at: null,
    token_refresh_error: null,
    token_refresh_failure_count: 0,
    ...overrides,
  };
}

function agedDays(days: number, overrides: Partial<MetaTokenProfile> = {}) {
  return profile({ token_refreshed_at: new Date(NOW - days * DAY).toISOString(), ...overrides });
}

test('token novo está saudável e ainda não entra na varredura', () => {
  const state = metaTokenRenewalState(agedDays(2), NOW);

  assert.equal(state.health, 'healthy');
  assert.equal(state.due, false);
  assert.equal(state.canRefreshNow, true);
});

test('a Meta recusa renovar antes de 24 h, e a política respeita isso', () => {
  const state = metaTokenRenewalState(agedDays(0.5), NOW);

  assert.equal(state.canRefreshNow, false);
  assert.equal(state.due, false);
});

test('exatamente 24 h já pode renovar', () => {
  assert.equal(metaTokenRenewalState(agedDays(1), NOW).canRefreshNow, true);
});

test('a partir de sete dias o token entra na varredura semanal', () => {
  assert.equal(metaTokenRenewalState(agedDays(META_TOKEN_REFRESH_AFTER_DAYS - 0.1), NOW).due, false);
  assert.equal(metaTokenRenewalState(agedDays(META_TOKEN_REFRESH_AFTER_DAYS), NOW).due, true);
});

test('a partir de 35 dias vira risco, ainda com folga para consertar', () => {
  const state = metaTokenRenewalState(agedDays(META_TOKEN_ALARM_AFTER_DAYS), NOW);

  assert.equal(state.health, 'at_risk');
  assert.equal(Math.round(state.daysUntilUnrefreshable ?? 0), 25);
  // Continua renovável: o alarme existe justamente para ser tratado antes.
  assert.equal(state.due, true);
});

test('passados 60 dias o refresh não alcança mais e insistir só esconde o caso', () => {
  const state = metaTokenRenewalState(agedDays(61), NOW);

  assert.equal(state.health, 'expired');
  assert.equal(state.canRefreshNow, false);
  assert.equal(state.due, false);
  assert.match(metaTokenRenewalLabel(state), /Reconecte este perfil/);
});

test('a borda dos 60 dias é o instante em que o refresh deixa de valer', () => {
  assert.equal(metaTokenRenewalState(agedDays(59.9), NOW).canRefreshNow, true);
  assert.equal(metaTokenRenewalState(agedDays(60.1), NOW).canRefreshNow, false);
});

test('sem idade conhecida não afirma saúde nem arrisca uma chamada que a Meta recusaria', () => {
  const state = metaTokenRenewalState(profile({ token_refreshed_at: null }), NOW);

  assert.equal(state.health, 'unknown');
  assert.equal(state.due, false);
  assert.equal(state.canRefreshNow, false);
});

test('perfil de outro provedor não entra na política da Meta', () => {
  const state = metaTokenRenewalState(profile({ provider: 'zernio' }), NOW);

  assert.equal(state.health, 'not_applicable');
  assert.equal(state.due, false);
});

test('renovação quebrada há semanas não se disfarça de token com folga', () => {
  // O ponto do token_refreshed_at: os dois perfis abaixo têm dezenas de dias
  // até expirar, mas só um deles está sendo renovado de verdade.
  const saudavel = metaTokenRenewalState(agedDays(3), NOW);
  const quebrado = metaTokenRenewalState(
    agedDays(38, { token_refresh_error: 'HTTP 500', token_refresh_failure_count: 5 }),
    NOW,
  );

  assert.equal(saudavel.health, 'healthy');
  assert.equal(quebrado.health, 'at_risk');
  assert.equal(quebrado.consecutiveFailures, 5);
  assert.notEqual(saudavel.health, quebrado.health);
});

test('o resumo da frota conta por estado, ignorando quem não é da Meta', () => {
  const summary = summarizeMetaTokenFleet([
    agedDays(1),
    agedDays(9),
    agedDays(40, { token_refresh_failure_count: 3 }),
    agedDays(70),
    profile({ token_refreshed_at: null }),
    profile({ provider: 'zernio' }),
  ], NOW);

  assert.deepEqual(summary, {
    total: 5,
    healthy: 1,
    due: 1,
    atRisk: 1,
    expired: 1,
    unknown: 1,
    failing: 1,
  });
});
