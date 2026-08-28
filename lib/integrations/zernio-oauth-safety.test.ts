import assert from 'node:assert/strict';
import test from 'node:test';

import { explicitZernioCallbackAccountId, explicitZernioCallbackProfileId, validateExplicitZernioCallbackAccount, validateExplicitZernioCallbackProfile, validateZernioCallbackState, zernioTerminalCallbackFailure } from './zernio-oauth-safety.ts';

test('aceita state presente porque a correlação forte usa turno e attempt persistidos', () => {
  assert.equal(validateZernioCallbackState('expected', new URLSearchParams({ state: 'expected' })).valid, true);
  assert.equal(validateZernioCallbackState('expected', new URLSearchParams({ state: 'instagram-state' })).valid, true);
  assert.equal(validateZernioCallbackState('expected', new URLSearchParams()).valid, true);
});

test('aceita callback padrão sem state porque a Zernio não o garante no redirect final', () => {
  assert.equal(validateZernioCallbackState(null, new URLSearchParams()).valid, true);
});

test('valida profileId explícito contra o profile canônico', () => {
  const params = new URLSearchParams({ profileId: 'profile-a' });
  assert.equal(explicitZernioCallbackProfileId(params), 'profile-a');
  assert.equal(validateExplicitZernioCallbackProfile({ explicitProfileId: 'profile-a', canonicalProfileId: 'profile-a' }).valid, true);
  assert.equal(validateExplicitZernioCallbackProfile({ explicitProfileId: 'profile-b', canonicalProfileId: 'profile-a' }).valid, false);
});

test('encaminha accountId explícito repetido ao worker para validar reassociação', () => {
  const params = new URLSearchParams({ accountId: 'known-account' });
  const accountId = explicitZernioCallbackAccountId(params);
  const result = validateExplicitZernioCallbackAccount({ explicitAccountId: accountId, baselineAccountIds: ['known-account'] });

  assert.equal(accountId, 'known-account');
  assert.equal(result.valid, true);
  assert.equal(result.requiresWorkerIdentityValidation, true);
});

test('aceita account ID explícito realmente novo', () => {
  const result = validateExplicitZernioCallbackAccount({ explicitAccountId: 'new-account', baselineAccountIds: ['known-account'] });
  assert.equal(result.valid, true);
  assert.equal(result.requiresWorkerIdentityValidation, false);
});

test('classifica cobrança e limite da Zernio como falha terminal', () => {
  const result = zernioTerminalCallbackFailure(new URLSearchParams({
    error: 'payment_required',
    reason: 'free_tier_exceeded',
  }));

  assert.deepEqual(result, { terminal: true, code: 'free_tier_exceeded' });
});

test('classifica autorização negada como falha terminal em vez de esperar a conta propagar', () => {
  assert.deepEqual(
    zernioTerminalCallbackFailure(new URLSearchParams({ error: 'oauth_denied', platform: 'instagram' })),
    { terminal: true, code: 'oauth_denied' },
  );
});

test('mantém connection_failed fora do terminal porque a conta costuma ser criada mesmo assim', () => {
  assert.deepEqual(
    zernioTerminalCallbackFailure(new URLSearchParams({ error: 'connection_failed', platform: 'instagram' })),
    { terminal: false, code: null },
  );
});

test('não classifica callback de autorização normal como falha terminal', () => {
  assert.deepEqual(
    zernioTerminalCallbackFailure(new URLSearchParams({ profileId: 'profile-a', accountId: 'account-a' })),
    { terminal: false, code: null },
  );
});

