import assert from 'node:assert/strict';
import test from 'node:test';

import { validateSharedZernioAccountPresence, zernioInstagramAccountCount } from './zernio-shared-removal.ts';

const shared = { accountId: 'account-123', username: 'PerfilDuplicado' };

test('confirma o mesmo account ID e identidade nas duas chaves', () => {
  assert.equal(validateSharedZernioAccountPresence({
    accountId: 'account-123',
    username: '@perfilduplicado',
    retainedAccounts: [shared],
    removedAccounts: [{ _id: 'account-123', username: '@PERFILDUPLICADO' }],
  }), 'present_both');
});

test('aceita ausência nas duas chaves para finalização idempotente', () => {
  assert.equal(validateSharedZernioAccountPresence({
    accountId: 'account-123',
    username: 'perfilduplicado',
    retainedAccounts: [],
    removedAccounts: [],
  }), 'absent_both');
});

test('bloqueia quando o account ID aparece em somente uma chave', () => {
  assert.throws(() => validateSharedZernioAccountPresence({
    accountId: 'account-123',
    username: 'perfilduplicado',
    retainedAccounts: [shared],
    removedAccounts: [],
  }), /apenas uma das duas chaves/);
});

test('bloqueia account ID associado a outra identidade', () => {
  assert.throws(() => validateSharedZernioAccountPresence({
    accountId: 'account-123',
    username: 'perfilduplicado',
    retainedAccounts: [shared],
    removedAccounts: [{ ...shared, username: 'outra_conta' }],
  }), /pertence a outra identidade/);
});

test('conta somente contas Instagram no snapshot confirmado', () => {
  assert.equal(zernioInstagramAccountCount([
    { accountId: 'instagram-1', platform: 'instagram' },
    { accountId: 'tiktok-1', platform: 'tiktok' },
    { accountId: 'instagram-2', platform: 'instagram' },
  ]), 2);
});
