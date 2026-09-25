import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMoreLoginCookie,
  buildMoreLoginProfileNote,
  extractAuthToken,
  parseMoreLoginAccounts,
} from './accounts.ts';

// Todos os valores aqui são inventados — o formato é o mesmo dos lotes reais.
const uuid = '9e5f94bc-e8a4-4e73-b8be-63364c29d753';
const refresh = 'M.C534_BAY.0.U.MsaArtifacts.-CtLywmXoVmnbAWfFiBA0KSIU0VzfoD1htLzdAuaQ0cAOcpknlRrJ*pD!1uJtXeLOiM5tNIkNfdJdvZTloWsRAQEy*fl1pi8Iuvt1pLNYMMvjJwB9M2nyp8O4YJpncm$';
const authToken = 'ebf3c223c6d1c033d2d2e2ee215d1ce7e0c8594e';
const cookie = `__cf_bm=abc-1786259031.0015068-1.0.1.1-xyz; client_token="258901-6639d1-PSwx3tfJVoaKM1gS5CAODnxMLyZ0WDhT3U1uSnAmEnY="; fm=0; ads_prefs="HBERAAA="; twid="u=2086347760765153280"; auth_token=${authToken}`;

// login|senha|2fa|email|senha do email|client_id|refresh_token|access_token|access_secret|device|cookie
const onzeCampos = `DonnyHoist09lv|yJQAhFmSlgQdt|TEF7LSEJF5UMZMD5|jacob8522@hotmail.com|jacob@556914|${uuid}|${refresh}|2086347760765153280-NX6zD8OfR8Jyb82SfoGAEvzbD3OqsB|eBkXbQZpQYhVX0JCmOhTvpKMkI45p6efvLpe88KfHMCrN|-|${cookie}`;
// login|senha|email|senha do email|OAUTH2|2fa|token
const seteCampos = `DonnyHoist09lv|yJQAhFmSlgQdt|jacob8522@hotmail.com|jacob@556914|${uuid}|TEF7LSEJF5UMZMD5|${authToken}`;

test('layout de 11 campos cai em cada lugar', () => {
  const { accounts, errors } = parseMoreLoginAccounts(onzeCampos);
  assert.deepEqual(errors, []);
  const [account] = accounts;
  assert.equal(account.login, 'DonnyHoist09lv');
  assert.equal(account.profileName, 'DonnyHoist09lv');
  assert.equal(account.password, 'yJQAhFmSlgQdt');
  assert.equal(account.twoFa, 'TEF7LSEJF5UMZMD5');
  assert.equal(account.email, 'jacob8522@hotmail.com');
  assert.equal(account.emailPassword, 'jacob@556914');
  assert.equal(account.clientId, uuid);
  assert.equal(account.refreshToken, refresh);
  assert.equal(account.accessToken, '2086347760765153280-NX6zD8OfR8Jyb82SfoGAEvzbD3OqsB');
  assert.equal(account.accessSecret, 'eBkXbQZpQYhVX0JCmOhTvpKMkI45p6efvLpe88KfHMCrN');
  assert.equal(account.device, '');
  assert.equal(account.cookie, cookie);
  assert.equal(account.authToken, authToken);
});

// O 2FA é o 3º campo num layout e o 6º no outro; o e-mail troca de lugar junto.
test('layout de 7 campos cai nos mesmos lugares, com a ordem trocada', () => {
  const { accounts, errors } = parseMoreLoginAccounts(seteCampos);
  assert.deepEqual(errors, []);
  const [account] = accounts;
  assert.equal(account.login, 'DonnyHoist09lv');
  assert.equal(account.password, 'yJQAhFmSlgQdt');
  assert.equal(account.email, 'jacob8522@hotmail.com');
  assert.equal(account.emailPassword, 'jacob@556914');
  assert.equal(account.clientId, uuid);
  assert.equal(account.twoFa, 'TEF7LSEJF5UMZMD5');
  assert.equal(account.authToken, authToken);
  assert.equal(account.cookie, '');
});

test('os dois layouts geram a mesma planilha', () => {
  const [deOnze] = parseMoreLoginAccounts(onzeCampos).accounts;
  const [deSete] = parseMoreLoginAccounts(seteCampos).accounts;
  const colunas = (account: typeof deOnze) => [account.profileName, account.login, account.password, account.twoFa, buildMoreLoginCookie(account), buildMoreLoginProfileNote(account)];
  assert.deepEqual(colunas(deSete), colunas(deOnze));
});

test('OAUTH2 pode ser o refresh token em vez do client_id', () => {
  const [account] = parseMoreLoginAccounts(`u|p|e@e.com|ep|${refresh}|TEF7LSEJF5UMZMD5|${authToken}`).accounts;
  assert.equal(account.refreshToken, refresh);
  assert.equal(account.clientId, '');
  assert.equal(account.twoFa, 'TEF7LSEJF5UMZMD5');
});

test('UUID é client_id e o token longo é refresh_token, nas duas ordens', () => {
  const [comoNoLote] = parseMoreLoginAccounts(`u|p|TEF7LSEJF5UMZMD5|e@e.com|ep|${uuid}|${refresh}`).accounts;
  assert.equal(comoNoLote.clientId, uuid);
  assert.equal(comoNoLote.refreshToken, refresh);
  const [invertido] = parseMoreLoginAccounts(`u|p|TEF7LSEJF5UMZMD5|e@e.com|ep|${refresh}|${uuid}`).accounts;
  assert.equal(invertido.clientId, uuid);
  assert.equal(invertido.refreshToken, refresh);
});

test('senha do email não é confundida com chave 2FA', () => {
  // A senha do e-mail é o campo logo depois dele, mesmo parecendo Base32.
  const [account] = parseMoreLoginAccounts('u|p|e@e.com|ABCDEFGHIJKLMNOP|TEF7LSEJF5UMZMD5').accounts;
  assert.equal(account.emailPassword, 'ABCDEFGHIJKLMNOP');
  assert.equal(account.twoFa, 'TEF7LSEJF5UMZMD5');
});

test('campo "-" e campo ausente contam como vazio', () => {
  const [account] = parseMoreLoginAccounts('login1|senha1|-|-|-|-|-').accounts;
  assert.equal(account.email, '');
  assert.equal(account.device, '');
  assert.equal(account.cookie, '');
  assert.equal(account.authToken, '');
  assert.equal(account.twoFa, '');
  const [comDevice] = parseMoreLoginAccounts('l|p|e@e.com|ep|Pixel 7').accounts;
  assert.equal(comDevice.device, 'Pixel 7');
});

test('formato curto com : ou ; continua funcionando', () => {
  const { accounts, errors } = parseMoreLoginAccounts('login1:senha1:aaaa-bbbb\nlogin2;senha2;CCCCDDDD');
  assert.deepEqual(errors, []);
  assert.deepEqual(accounts.map((account) => [account.login, account.password, account.twoFa]), [
    ['login1', 'senha1', 'AAAABBBB'],
    ['login2', 'senha2', 'CCCCDDDD'],
  ]);
});

test('linha sem login ou senha vira erro apontando a linha', () => {
  const { accounts, errors } = parseMoreLoginAccounts(`\n|senha|AAAA|\nlogin\n${seteCampos}`);
  assert.equal(accounts.length, 1);
  assert.deepEqual(errors.map((error) => error.line), [2, 3]);
  assert.match(errors[0].reason, /login\|senha\|2fa/);
  assert.match(errors[1].reason, /usuario:senha:2fa/);
});

test('linha completa sem 2FA é aceita; curta sem 2FA não', () => {
  assert.equal(parseMoreLoginAccounts('login1|senha1||e@e.com').accounts.length, 1);
  assert.equal(parseMoreLoginAccounts('login1:senha1:').errors.length, 1);
});

test('auth_token sai avulso ou do meio do cookie', () => {
  assert.equal(extractAuthToken(cookie), authToken);
  assert.equal(extractAuthToken(`auth_token=${authToken}`), authToken);
  assert.equal(extractAuthToken(authToken), authToken);
  assert.equal(extractAuthToken('twid="u=123"; fm=0'), '');
  const [account] = parseMoreLoginAccounts(onzeCampos).accounts;
  assert.equal(buildMoreLoginCookie(account), `auth_token=${authToken}`);
});

test('observação leva só email, senha do email e device', () => {
  const [account] = parseMoreLoginAccounts(onzeCampos).accounts;
  assert.equal(buildMoreLoginProfileNote(account), 'email: jacob8522@hotmail.com\nsenha do email: jacob@556914');
  const [comDevice] = parseMoreLoginAccounts('l|p|e@e.com|ep|Pixel 7').accounts;
  assert.equal(buildMoreLoginProfileNote(comDevice), 'email: e@e.com\nsenha do email: ep\ndevice: Pixel 7');
  const [semNada] = parseMoreLoginAccounts('l:p:AAAABBBBCCCCDDDD').accounts;
  assert.equal(buildMoreLoginProfileNote(semNada), '');
});
