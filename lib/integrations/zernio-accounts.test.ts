import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyZernioAccountAgainstBaseline, selectNewZernioAccountsForAttempt, selectZernioInstagramAccountsForSync, zernioAccountIdentitySnapshot } from './zernio-account-selection.ts';

const accounts = [
  { accountId: 'instagram-primary', platform: 'instagram' as const, profileId: 'profile-primary' },
  { accountId: 'instagram-historical', platform: 'instagram' as const, profileId: 'profile-historical' },
  { accountId: 'facebook', platform: 'facebook' as const, profileId: 'profile-primary' },
];

test('sincronização administrativa respeita o profile canônico da chave', () => {
  const result = selectZernioInstagramAccountsForSync(accounts, ['profile-primary'], false);

  assert.deepEqual(result.map((account) => account.accountId), ['instagram-primary']);
});

test('callback de tentativa continua isolado ao profile da autorização atual', () => {
  const result = selectZernioInstagramAccountsForSync(accounts, ['profile-primary'], true);

  assert.deepEqual(result.map((account) => account.accountId), ['instagram-primary']);
});

test('callback não importa conta sem profile quando há profile canônico', () => {
  const result = selectZernioInstagramAccountsForSync([
    ...accounts,
    { accountId: 'ambiguous', platform: 'instagram' as const },
  ], ['profile-primary'], true);

  assert.deepEqual(result.map((account) => account.accountId), ['instagram-primary']);
});

test('sincronização administrativa também rejeita conta sem profileId ambígua', () => {
  const result = selectZernioInstagramAccountsForSync([
    { accountId: 'ambiguous', platform: 'instagram' as const },
  ], ['profile-primary'], false);

  assert.deepEqual(result, []);
});

test('endpoint global não atribui contas de outro profile à conexão atual', () => {
  const result = selectZernioInstagramAccountsForSync([
    { accountId: 'account-a', platform: 'instagram' as const, profileId: 'profile-a' },
    { accountId: 'account-b', platform: 'instagram' as const, profileId: { _id: 'profile-b' } },
  ], ['profile-b'], false);

  assert.deepEqual(result.map((account) => account.accountId), ['account-b']);
});

test('attempt reconcilia somente IDs novos em relação ao baseline', () => {
  const result = selectNewZernioAccountsForAttempt([
    { accountId: 'known', platform: 'instagram' },
    { accountId: 'new', platform: 'instagram' },
  ], ['known']);

  assert.deepEqual(result.map((account) => account.accountId), ['new']);
});

test('extrai identidade imutável do Instagram do payload Zernio', () => {
  const snapshot = zernioAccountIdentitySnapshot({
    accountId: 'remote-account', platform: 'instagram', profileId: 'profile-a', username: '@Example',
    metadata: { profileData: { id: 'instagram-immutable-id' } },
  });
  assert.deepEqual(snapshot, {
    accountId: 'remote-account', profileId: 'profile-a', username: 'example', instagramIdentityId: 'instagram-immutable-id',
  });
});

test('classifica reutilização comprovada do mesmo accountId como reassociação', () => {
  const result = classifyZernioAccountAgainstBaseline({
    accountId: 'reused', platform: 'instagram', username: 'new-user',
    metadata: { profileData: { id: 'instagram-new' } },
  }, [{ accountId: 'reused', profileId: 'profile-a', username: 'old-user', instagramIdentityId: 'instagram-old' }]);
  assert.equal(result.kind, 'reassociated');
});

test('não aceita conta já existente como nova', () => {
  const result = classifyZernioAccountAgainstBaseline({
    accountId: 'same', platform: 'instagram', username: 'same-user',
    metadata: { profileData: { id: 'instagram-same' } },
  }, [{ accountId: 'same', profileId: 'profile-a', username: 'same-user', instagramIdentityId: 'instagram-same' }]);
  assert.equal(result.kind, 'existing');
});

test('bloqueia reutilização ambígua sem identidade imutável', () => {
  const result = classifyZernioAccountAgainstBaseline({ accountId: 'same', platform: 'instagram', username: 'changed' }, [
    { accountId: 'same', profileId: 'profile-a', username: 'old', instagramIdentityId: null },
  ]);
  assert.equal(result.kind, 'ambiguous_reuse');
});
