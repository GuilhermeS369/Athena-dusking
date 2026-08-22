import { assertMicros } from './pricing.ts';

export type TwitterExternalOutcome =
  | 'local_preflight_failure'
  | 'confirmed_failure_no_charge'
  | 'rate_limited_no_charge'
  | 'accepted'
  | 'processing'
  | 'published'
  | 'existing_post'
  | 'unknown_after_external_call';

export type TwitterFinancialAction = 'release' | 'keep_for_retry' | 'keep_hold' | 'settle' | 'mark_unknown';

export function financialActionForTwitterOutcome(outcome: TwitterExternalOutcome): TwitterFinancialAction {
  switch (outcome) {
    case 'local_preflight_failure':
    case 'confirmed_failure_no_charge':
      return 'release';
    case 'rate_limited_no_charge':
      return 'keep_for_retry';
    case 'accepted':
    case 'processing':
      return 'keep_hold';
    case 'published':
    case 'existing_post':
      return 'settle';
    case 'unknown_after_external_call':
      return 'mark_unknown';
  }
}

export function assertTwitterReservationInvariant(input: {
  initialMicros: number;
  remainingMicros: number;
  settledMicros: number;
  releasedMicros: number;
}) {
  const initial = assertMicros(input.initialMicros, 'initialMicros');
  const remaining = assertMicros(input.remainingMicros, 'remainingMicros');
  const settled = assertMicros(input.settledMicros, 'settledMicros');
  const released = assertMicros(input.releasedMicros, 'releasedMicros');
  if (remaining + settled + released !== initial) {
    throw new Error('Reserva inconsistente: remaining + settled + released deve ser igual ao valor inicial.');
  }
  return true;
}

export function getTwitterAnalyticsCapacity(input: {
  postedBalanceMicros: number;
  allOpenReservationsMicros: number;
  publicationReservationsMicros: number;
  protectedFloorMicros: number;
}) {
  const posted = assertMicros(input.postedBalanceMicros, 'postedBalanceMicros');
  const allReserved = assertMicros(input.allOpenReservationsMicros, 'allOpenReservationsMicros');
  const publicationReserved = assertMicros(input.publicationReservationsMicros, 'publicationReservationsMicros');
  const floor = assertMicros(input.protectedFloorMicros, 'protectedFloorMicros');
  if (publicationReserved > allReserved) throw new Error('Reservas de publicação não podem superar todas as reservas.');
  return Math.max(0, posted - allReserved - floor);
}
