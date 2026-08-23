import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTwitterZernioClient,
  immutableTwitterUserId,
  isTwitterOnlyAccountInventory,
  stableZernioAccountId,
} from './zernio-client.ts';

test('cliente X usa apenas endpoints Twitter e mantém Inbox desligado ao configurar capabilities', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify({ valid: true, userId: 'user-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const client = createTwitterZernioClient('secret-value', {
    baseUrl: 'https://example.test/api',
    fetchImpl,
    timeoutMs: 5_000,
  });

  await client.verifyAuth();
  await client.listAccounts('profile-1');
  await client.listTwitterAccounts('profile-1');
  await client.getTwitterAccountHealth('profile-1');
  await client.setAccountCapabilities('account-1', { analytics: true });

  assert.equal(requests[0]?.url, 'https://example.test/api/v1/auth/verify');
  assert.doesNotMatch(requests[1]?.url ?? '', /platform=twitter/);
  assert.match(requests[2]?.url ?? '', /platform=twitter/);
  assert.match(requests[3]?.url ?? '', /accounts%2Fhealth|accounts\/health/);
  assert.deepEqual(JSON.parse(String(requests[4]?.init?.body)), {
    xCapabilities: { analytics: true, inbox: false },
  });
  assert.equal(requests.some((item) => item.url.includes('billing')), false);
});

test('profile existente só é adotado quando todo o inventário é exclusivamente Twitter', () => {
  assert.equal(isTwitterOnlyAccountInventory([{ platform: 'twitter' }]), true);
  assert.equal(isTwitterOnlyAccountInventory([{ platform: 'Twitter' }, { platform: 'twitter' }]), true);
  assert.equal(isTwitterOnlyAccountInventory([]), false);
  assert.equal(isTwitterOnlyAccountInventory([{ platform: 'twitter' }, { platform: 'instagram' }]), false);
  assert.equal(isTwitterOnlyAccountInventory([{ platform: undefined }]), false);
});

test('identidade imutável nunca usa username como fallback', () => {
  const account = { _id: 'z-account', username: 'nome_mutavel', profileData: { id: 'x-immutable' } };
  assert.equal(stableZernioAccountId(account), 'z-account');
  assert.equal(immutableTwitterUserId(account), 'x-immutable');
  assert.equal(immutableTwitterUserId({ _id: 'z-account', username: 'nome_mutavel' }), null);
});

test('erro Zernio não expõe bearer e preserva código/request id', async () => {
  const client = createTwitterZernioClient('super-secret', {
    baseUrl: 'https://example.test/api',
    timeoutMs: 5_000,
    fetchImpl: async () => new Response(JSON.stringify({ code: 'invalid_key', message: 'Não autorizado' }), {
      status: 401,
      headers: { 'x-request-id': 'req-1' },
    }),
  });
  await assert.rejects(client.verifyAuth(), (error: Error & { code?: string; requestId?: string }) => {
    assert.equal(error.code, 'invalid_key');
    assert.equal(error.requestId, 'req-1');
    assert.doesNotMatch(error.message, /super-secret/);
    return true;
  });
});

test('auditoria de uso consulta somente o snapshot de billing sem ler recursos X', async () => {
  const requests: string[] = [];
  const client = createTwitterZernioClient('secret-value', {
    baseUrl: 'https://example.test/api',
    timeoutMs: 5_000,
    fetchImpl: async (input) => {
      requests.push(String(input));
      return new Response(JSON.stringify({
        billingSystem: 'metronome',
        usage: { xApiCallsByOperation: { posts_read: 1 } },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });

  const snapshot = await client.getUsageSnapshot();
  assert.deepEqual(snapshot.usage?.xApiCallsByOperation, { posts_read: 1 });
  assert.deepEqual(requests, ['https://example.test/api/v1/usage']);
  assert.equal(requests.some((url) => url.includes('/analytics') || url.includes('/posts/')), false);
});
