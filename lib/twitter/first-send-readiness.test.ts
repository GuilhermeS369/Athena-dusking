import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { classifyFirstSendReadiness, type FirstSendReadinessInput } from './first-send-readiness.ts';

const ready: FirstSendReadinessInput = {
  connectionActive: true,
  activeProfiles: 1,
  postableProfiles: 1,
  walletPresent: true,
  availableMicros: 12_000_000,
  totalItems: 0,
  publishedItems: 0,
  pendingItems: 0,
  unknownItems: 0,
  unknownReservations: 0,
  staleWorkers: 0,
  openBreakers: 0,
};

describe('classifyFirstSendReadiness', () => {
  it('distingue conexão sem perfil, pronta, em acompanhamento e aprovada', () => {
    assert.equal(classifyFirstSendReadiness({ ...ready, activeProfiles: 0, postableProfiles: 0 }).state, 'awaiting_profile');
    assert.equal(classifyFirstSendReadiness(ready).state, 'ready_for_first_program');
    assert.equal(classifyFirstSendReadiness({ ...ready, totalItems: 1, pendingItems: 1 }).state, 'monitoring_first_send');
    assert.deepEqual(
      classifyFirstSendReadiness({ ...ready, totalItems: 1, publishedItems: 1 }),
      { state: 'first_send_approved', approved: true, blockers: [] },
    );
  });

  it('bloqueia resultados incertos e falhas operacionais ou financeiras', () => {
    const result = classifyFirstSendReadiness({
      ...ready,
      unknownItems: 1,
      unknownReservations: 1,
      staleWorkers: 1,
      openBreakers: 1,
    });
    assert.equal(result.state, 'blocked');
    assert.equal(result.approved, false);
    assert.deepEqual(result.blockers, [
      'publication_outcome_unknown',
      'financial_outcome_unknown',
      'worker_stale',
      'circuit_breaker_open',
    ]);
  });

  it('exige carteira, perfil publicável e custo mínimo de um post sem URL', () => {
    const result = classifyFirstSendReadiness({
      ...ready,
      walletPresent: false,
      postableProfiles: 0,
      availableMicros: 14_999,
    });
    assert.deepEqual(result.blockers, ['wallet_missing', 'no_postable_profile', 'insufficient_minimum_balance']);
  });

  it('mantém a auditoria operacional somente leitura e sem chamadas à Zernio', async () => {
    const source = await readFile(
      new URL('../../scripts/twitter/audit-first-send-readiness.ts', import.meta.url),
      'utf8',
    );
    assert.match(source, /readOnly:\s*true/);
    assert.match(source, /providerCalls:\s*false/);
    assert.match(source, /twitter_connections/);
    assert.match(source, /twitter_wallet_reservations/);
    assert.doesNotMatch(source, /loadTwitterZernioConnection|\.insert\(|\.update\(|\.delete\(|\.rpc\(/);
    assert.doesNotMatch(source, /instagram_profiles|publication_items(?!')/);
  });
});
