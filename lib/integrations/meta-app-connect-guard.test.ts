import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * A credencial global da Meta deixou de abrir conexões novas. Ela sobrevive só
 * como retaguarda das contas que já existiam. Estes testes leem o código-fonte
 * porque o que precisa ser garantido não é o retorno de uma função: é que
 * nenhum caminho de conexão volte a ler a variável de ambiente por atalho.
 */

const oauthSource = readFileSync(new URL('./meta-oauth.ts', import.meta.url), 'utf8');
const startSource = readFileSync(
  new URL('../../app/api/integrations/meta/start/route.ts', import.meta.url),
  'utf8',
);
const callbackSource = readFileSync(
  new URL('../../app/api/integrations/meta/callback/route.ts', import.meta.url),
  'utf8',
);

test('a URL de autorização recebe o client_id de quem chama, não do ambiente', () => {
  assert.match(oauthSource, /buildMetaAuthorizationUrl\([^)]*clientId: string/);
  assert.match(oauthSource, /url\.searchParams\.set\('client_id', clientId\)/);
});

test('as antigas metaClientId/metaClientSecret não existem mais', () => {
  // Elas lançavam quando a variável faltava, o que tornava a credencial global
  // um requisito do fluxo inteiro. Só resta a versão explicitamente legada.
  assert.doesNotMatch(oauthSource, /export function metaClientId\b/);
  assert.doesNotMatch(oauthSource, /export function metaClientSecret\b/);
  assert.match(oauthSource, /export function legacyMetaAppCredentials\b/);
});

test('o /start recusa a conexão sem app cadastrado antes de abrir o OAuth', () => {
  const guardIndex = startSource.indexOf("'meta_app_required'");
  // lastIndexOf porque a primeira ocorrência do nome é o import, no topo.
  const redirectIndex = startSource.lastIndexOf('buildMetaAuthorizationUrl(');

  assert.notEqual(guardIndex, -1);
  assert.ok(guardIndex < redirectIndex, 'a barreira precisa vir antes do redirecionamento');
  assert.match(startSource, /if \(!metaAppId\)/);
});

test('o /start confere a vaga do app antes de mandar alguém autorizar no celular', () => {
  assert.match(startSource, /let requireFreeSlot = true;/);
  assert.match(startSource, /resolveMetaAppCredentials\(organizationId, metaAppId, \{ requireFreeSlot \}\)/);

  // A vaga só é dispensada dentro do ramo de reautorização, onde o perfil já
  // ocupa a dele. Uma conexão nova nunca chega ao OAuth com o app cheio.
  const relaxIndex = startSource.indexOf('requireFreeSlot = false');
  const reauthorizeBranchIndex = startSource.indexOf('if (!metaAppId && reauthorizeProfileId)');

  assert.notEqual(relaxIndex, -1);
  assert.ok(reauthorizeBranchIndex !== -1 && reauthorizeBranchIndex < relaxIndex);
  assert.equal(startSource.split('requireFreeSlot = false').length - 1, 1);
});

test('o callback troca o código com a credencial do app assinado no state', () => {
  assert.match(callbackSource, /client_id: clientId/);
  assert.match(callbackSource, /client_secret: clientSecret/);
  assert.doesNotMatch(callbackSource, /metaClientSecret\(\)/);
  assert.match(callbackSource, /resolveMetaAppCredentials\(state\.organizationId, state\.metaAppId/);
});

test('o perfil salvo registra o app que o conectou', () => {
  // A gravacao passou a ser feita pela RPC connect_meta_instagram_profile
  // (migration 373), entao o app viaja como parametro em vez de campo do upsert.
  assert.match(callbackSource, /p_meta_app_id: metaApp\?\.id \?\? null/);
});

test('o grupo só é vinculado depois de o perfil existir, e a falha não derruba a conexão', () => {
  // A gravacao do perfil agora e a RPC; comparar com o upsert antigo deixaria
  // este teste passando por vacuidade (indexOf devolvendo -1).
  const upsertIndex = callbackSource.indexOf("rpc('connect_meta_instagram_profile'");
  const assignmentIndex = callbackSource.indexOf('assignProfileToGroup(admin');

  assert.notEqual(assignmentIndex, -1);
  assert.ok(upsertIndex < assignmentIndex);
  assert.match(callbackSource, /assignProfileToGroup\(admin[\s\S]*?\.catch\(/);
  assert.match(callbackSource, /ignoreDuplicates: true/);
});
