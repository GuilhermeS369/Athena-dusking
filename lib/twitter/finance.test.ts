import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertTwitterReservationInvariant,
  financialActionForTwitterOutcome,
  getTwitterAnalyticsCapacity,
} from './finance.ts';

test('matriz financeira distingue liberar, manter, liquidar e desconhecido', () => {
  assert.equal(financialActionForTwitterOutcome('local_preflight_failure'), 'release');
  assert.equal(financialActionForTwitterOutcome('rate_limited_no_charge'), 'keep_for_retry');
  assert.equal(financialActionForTwitterOutcome('processing'), 'keep_hold');
  assert.equal(financialActionForTwitterOutcome('existing_post'), 'settle');
  assert.equal(financialActionForTwitterOutcome('unknown_after_external_call'), 'mark_unknown');
});

test('reserva sempre fecha a equação financeira', () => {
  assert.equal(assertTwitterReservationInvariant({
    initialMicros: 200_000,
    remainingMicros: 100_000,
    settledMicros: 50_000,
    releasedMicros: 50_000,
  }), true);
  assert.throws(() => assertTwitterReservationInvariant({
    initialMicros: 200_000,
    remainingMicros: 100_000,
    settledMicros: 50_000,
    releasedMicros: 40_000,
  }));
});

test('analytics preserva piso sobre o saldo já livre de todas as reservas', () => {
  assert.equal(getTwitterAnalyticsCapacity({
    postedBalanceMicros: 12_000_000,
    allOpenReservationsMicros: 2_000_000,
    publicationReservationsMicros: 2_000_000,
    protectedFloorMicros: 5_000_000,
  }), 5_000_000);
  assert.equal(getTwitterAnalyticsCapacity({
    postedBalanceMicros: 6_000_000,
    allOpenReservationsMicros: 2_000_000,
    publicationReservationsMicros: 1_500_000,
    protectedFloorMicros: 5_000_000,
  }), 0);
});
