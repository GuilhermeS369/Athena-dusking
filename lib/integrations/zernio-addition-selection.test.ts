import assert from 'node:assert/strict';
import test from 'node:test';

import { selectZernioAdditionCandidates } from './zernio-addition-selection.ts';

const baseline = [{
  accountId: 'recycled',
  profileId: 'profile-1',
  username: 'old-user',
  instagramIdentityId: 'ig-old',
}];

test('callback superseded não escolhe outra conta visível', () => {
  const result = selectZernioAdditionCandidates({
    accounts: [{ accountId: 'other', platformUserId: 'ig-other' }],
    baseline,
    explicitAccountId: 'recycled',
  });

  assert.equal(result.explicitAccountMissing, true);
  assert.deepEqual(result.candidateAccounts, []);
});

test('fallback sem accountId explícito detecta reassociação reciclada', () => {
  const reassociated = { accountId: 'recycled', platformUserId: 'ig-new', username: 'new-user' };
  const result = selectZernioAdditionCandidates({ accounts: [reassociated], baseline });

  assert.equal(result.explicitAccountMissing, false);
  assert.deepEqual(result.candidateAccounts, [reassociated]);
});

test('fallback não aceita conta existente como nova', () => {
  const existing = { accountId: 'recycled', platformUserId: 'ig-old', username: 'old-user' };
  const result = selectZernioAdditionCandidates({ accounts: [existing], baseline });

  assert.deepEqual(result.candidateAccounts, []);
  assert.equal(result.existingAccount, existing);
});

test('reutilização sem identidade imutável permanece ambígua', () => {
  const result = selectZernioAdditionCandidates({
    accounts: [{ accountId: 'recycled', username: 'new-user' }],
    baseline: [{ ...baseline[0], instagramIdentityId: null }],
  });

  assert.deepEqual(result.candidateAccounts, []);
  assert.equal(result.ambiguousReuse?.accountId, 'recycled');
});
