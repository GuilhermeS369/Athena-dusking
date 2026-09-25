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

// login:senha:2fa:email:senha do email:token_longo:auth_token — tudo com `:`.
test('layout completo separado por dois-pontos cai nos mesmos lugares', () => {
  const longToken = 'a'.repeat(128);
  const linha = `TestUser1:abc123XY:TEF7LSEJF5UMZMD5:someone@rambler.ru:pw9xZ:${longToken}:${authToken}`;
  const { accounts, errors } = parseMoreLoginAccounts(linha);
  assert.deepEqual(errors, []);
  const [account] = accounts;
  assert.equal(account.login, 'TestUser1');
  assert.equal(account.password, 'abc123XY');
  assert.equal(account.twoFa, 'TEF7LSEJF5UMZMD5');
  assert.equal(account.email, 'someone@rambler.ru');
  assert.equal(account.emailPassword, 'pw9xZ');
  assert.equal(account.refreshToken, longToken);
  assert.equal(account.authToken, authToken);
  assert.equal(buildMoreLoginCookie(account), `auth_token=${authToken}`);
  assert.equal(buildMoreLoginProfileNote(account), 'email: someone@rambler.ru\nsenha do email: pw9xZ');
});

test('linhas de cabeçalho "Account #N" são ignoradas, não viram erro', () => {
  const bloco = `Account #1\nTestUser1:abc123XY:TEF7LSEJF5UMZMD5:someone@rambler.ru:pw9xZ:${'a'.repeat(128)}:${authToken}\nAccount #2\nTestUser2:def456ZW:BEO7E6ZOMZ67SCKM:other@rambler.ru:pw2Yy:${'c'.repeat(128)}:${authToken}`;
  const { accounts, errors } = parseMoreLoginAccounts(bloco);
  assert.deepEqual(errors, []);
  assert.deepEqual(accounts.map((account) => account.login), ['TestUser1', 'TestUser2']);
});

test('exatamente três campos com dois-pontos continua sendo o formato curto', () => {
  const [account] = parseMoreLoginAccounts('login1:senha1:TEF7LSEJF5UMZMD5').accounts;
  assert.equal(account.login, 'login1');
  assert.equal(account.password, 'senha1');
  assert.equal(account.twoFa, 'TEF7LSEJF5UMZMD5');
  assert.equal(account.email, '');
});

// login|senha|email|senha|telefone|token_longo|auth_token|2fa|data|n|n|n|false|pais| email|senha|refresh|client_id
test('modelo de 18 campos com telefone, data, contadores e país', () => {
  const longHex = 'a'.repeat(128);
  const refresh = `M.C515_BL2.0.U.MsaArtifacts.-${'x'.repeat(200)}$$`;
  const linha = `TestLogin1|PassWord12|user1@outlook.com|ep111|+201118654336|${longHex}|${authToken}|HOMWGUD7F23GIAZI|04-02-2021|1|9|0|false|Egypt | user1@outlook.com|ep111|${refresh}|${uuid}`;
  const { accounts, errors } = parseMoreLoginAccounts(linha);
  assert.deepEqual(errors, []);
  const [account] = accounts;
  assert.equal(account.login, 'TestLogin1');
  assert.equal(account.password, 'PassWord12');
  assert.equal(account.twoFa, 'HOMWGUD7F23GIAZI');
  assert.equal(account.email, 'user1@outlook.com');
  assert.equal(account.emailPassword, 'ep111');
  assert.equal(account.phone, '+201118654336');
  assert.equal(account.authToken, authToken);
  assert.equal(account.clientId, uuid);
  assert.equal(buildMoreLoginCookie(account), `auth_token=${authToken}`);
  assert.equal(buildMoreLoginProfileNote(account), 'email: user1@outlook.com\nsenha do email: ep111\ntelefone: +201118654336');
});

test('cookie em base64 é convertido para extrair o auth_token', () => {
  const cookieText = `lang=en; auth_token=${authToken}; ct0=abcdef0123456789`;
  const base64 = Buffer.from(cookieText).toString('base64');
  assert.equal(extractAuthToken(base64), authToken);
  const [account] = parseMoreLoginAccounts(`login1|senha1|e@e.com|ep|${base64}`).accounts;
  assert.equal(account.authToken, authToken);
  assert.equal(buildMoreLoginCookie(account), `auth_token=${authToken}`);
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
  assert.equal(account.phone, '');
  assert.equal(account.cookie, '');
  assert.equal(account.authToken, '');
  assert.equal(account.twoFa, '');
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

test('observação leva email, senha do email e telefone', () => {
  const [account] = parseMoreLoginAccounts(onzeCampos).accounts;
  assert.equal(buildMoreLoginProfileNote(account), 'email: jacob8522@hotmail.com\nsenha do email: jacob@556914');
  const [comTelefone] = parseMoreLoginAccounts('l|p|e@e.com|ep|+201118654336').accounts;
  assert.equal(buildMoreLoginProfileNote(comTelefone), 'email: e@e.com\nsenha do email: ep\ntelefone: +201118654336');
  const [semNada] = parseMoreLoginAccounts('l:p:AAAABBBBCCCCDDDD').accounts;
  assert.equal(buildMoreLoginProfileNote(semNada), '');
});
