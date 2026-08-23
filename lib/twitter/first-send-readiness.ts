export type FirstSendReadinessState =
  | 'awaiting_profile'
  | 'ready_for_first_program'
  | 'monitoring_first_send'
  | 'first_send_approved'
  | 'blocked';

export type FirstSendReadinessInput = {
  connectionActive: boolean;
  activeProfiles: number;
  postableProfiles: number;
  walletPresent: boolean;
  availableMicros: number;
  totalItems: number;
  publishedItems: number;
  pendingItems: number;
  unknownItems: number;
  unknownReservations: number;
  staleWorkers: number;
  openBreakers: number;
};

export type FirstSendReadiness = {
  state: FirstSendReadinessState;
  approved: boolean;
  blockers: string[];
};

export function classifyFirstSendReadiness(input: FirstSendReadinessInput): FirstSendReadiness {
  const blockers: string[] = [];

  if (!input.connectionActive) blockers.push('connection_inactive');
  if (!input.walletPresent) blockers.push('wallet_missing');
  if (input.activeProfiles > 0 && input.postableProfiles === 0) blockers.push('no_postable_profile');
  if (input.availableMicros < 15_000) blockers.push('insufficient_minimum_balance');
  if (input.unknownItems > 0) blockers.push('publication_outcome_unknown');
  if (input.unknownReservations > 0) blockers.push('financial_outcome_unknown');
  if (input.staleWorkers > 0) blockers.push('worker_stale');
  if (input.openBreakers > 0) blockers.push('circuit_breaker_open');

  if (blockers.length > 0) return { state: 'blocked', approved: false, blockers };
  if (input.activeProfiles === 0) return { state: 'awaiting_profile', approved: false, blockers: [] };
  if (input.publishedItems > 0) return { state: 'first_send_approved', approved: true, blockers: [] };
  if (input.pendingItems > 0 || input.totalItems > 0) {
    return { state: 'monitoring_first_send', approved: false, blockers: [] };
  }
  return { state: 'ready_for_first_program', approved: false, blockers: [] };
}
