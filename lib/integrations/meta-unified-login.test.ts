import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMetaUnifiedLoginUrl,
  exchangeMetaUnifiedCode,
  fetchMetaUnifiedBusinessId,
  listMetaUnifiedAccounts,
  MetaUnifiedError,
} from './meta-unified-login.ts';

type Route = { match: string; status?: number; body: unknown };

function fakeFetch(routes: Route[]) {
  const calls: { url: URL; authorization: string | undefined }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({ url, authorization: headers?.Authorization });
    const route = routes.find((candidate) => `${url.pathname}${url.search}`.includes(candidate.match));
    if (!route) throw new Error(`sem rota para ${url}`);
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
  }) as typeof fetch;
  return { impl, calls };
}

test('o link leva config_id, e não scope', () => {
  const url = buildMetaUnifiedLoginUrl('estado', 'https://exemplo.test/callback', '123', '456');

  assert.equal(url.hostname, 'www.facebook.com');
  assert.match(url.pathname, /\/dialog\/oauth$/);
  assert.equal(url.searchParams.get('client_id'), '123');
  assert.equal(url.searchParams.get('config_id'), '456');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), 'estado');
  assert.equal(url.searchParams.get('prompt'), 'login');
  assert.equal(url.searchParams.has('scope'), false);
});

test('a troca do código usa graph.facebook.com e aceita token sem prazo', async () => {
  const { impl, calls } = fakeFetch([{ match: 'oauth/access_token', body: { access_token: 'tok' } }]);
  const token = await exchangeMetaUnifiedCode(
    { clientId: '1', clientSecret: 's', code: 'c', redirectUri: 'https://exemplo.test/cb' },
    impl,
  );

  assert.deepEqual(token, { accessToken: 'tok', expiresIn: null });
  assert.equal(calls[0].url.hostname, 'graph.facebook.com');
  assert.equal(calls[0].url.searchParams.get('redirect_uri'), 'https://exemplo.test/cb');
});

test('erro da Meta preserva código e subcódigo no diagnóstico, sem o token', async () => {
  const { impl } = fakeFetch([{
    match: 'assigned_instagram_accounts',
    status: 400,
    body: { error: { code: 100, error_subcode: 33, type: 'GraphMethodException', message: 'Unsupported get request' } },
  }]);

  await assert.rejects(listMetaUnifiedAccounts('segredo', impl), (error: unknown) => {
    assert.ok(error instanceof MetaUnifiedError);
    const diagnostic = error.toDiagnostic();
    assert.equal(error.stage, 'unified_account_list');
    assert.match(diagnostic, /"subcode":33/);
    assert.doesNotMatch(diagnostic, /segredo/);
    return true;
  });
});

test('um token traz todas as contas, paginando e completando quem vem sem username', async () => {
  const { impl, calls } = fakeFetch([
    {
      match: 'after=cursor2',
      body: { data: [{ id: '30', username: 'terceira' }] },
    },
    {
      match: 'assigned_instagram_accounts',
      body: {
        data: [{ id: '10', username: 'primeira', name: 'A' }, { id: 20 }],
        paging: { cursors: { after: 'cursor2' }, next: 'https://graph.facebook.com/proxima' },
      },
    },
    {
      match: '/20?',
      body: { username: 'segunda', profile_picture_url: 'https://foto.test/2' },
    },
  ]);

  const accounts = await listMetaUnifiedAccounts('tok', impl);

  assert.deepEqual(accounts.map((account) => [account.id, account.username]), [
    ['10', 'primeira'],
    ['20', 'segunda'],
    ['30', 'terceira'],
  ]);
  assert.equal(accounts[1].profilePictureUrl, 'https://foto.test/2');
  assert.ok(calls.every((call) => call.authorization === 'Bearer tok'));
});

test('falha ao ler o portfólio não derruba a conexão', async () => {
  const { impl } = fakeFetch([{ match: '/me', status: 400, body: { error: { code: 100 } } }]);
  assert.equal(await fetchMetaUnifiedBusinessId('tok', impl), null);
});
