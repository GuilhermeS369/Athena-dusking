#!/usr/bin/env node

// Operação destrutiva excepcional: desconecta globalmente um account ID que a
// Zernio expõe em duas chaves. Não altera nem exclui o perfil local.
import { createDecipheriv, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

for (const filePath of ['.env.local', '.env.worker.deploy']) {
  if (!fs.existsSync(filePath)) continue;
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    const separator = line.indexOf('=');
    if (!line || line.startsWith('#') || separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (process.env[key]) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

const argument = (name) => process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1)?.trim() ?? null;
const normalizeUsername = (value) => String(value ?? '').replace(/^@/, '').trim().toLocaleLowerCase('en-US');
const remoteId = (account) => account.accountId ?? account._id ?? account.id ?? null;
const username = normalizeUsername(argument('--username'));
const accountId = argument('--account-id');
const canonicalConnectionId = argument('--canonical-connection-id');
const sourceConnectionId = argument('--source-connection-id');
const outputPath = argument('--output');

if (!process.argv.includes('--apply')) throw new Error('Operação destrutiva bloqueada sem --apply explícito.');
if (!username || !accountId || !canonicalConnectionId || !sourceConnectionId || !outputPath) {
  throw new Error('Informe username, account ID, conexões canônica/origem e arquivo de saída.');
}
if (canonicalConnectionId === sourceConnectionId) throw new Error('As conexões canônica e origem devem ser diferentes.');

function decryptToken(payload) {
  const [version, ivValue, tagValue, encryptedValue] = payload.split('.');
  if (version !== 'v1' || !ivValue || !tagValue || !encryptedValue) throw new Error('Chave Zernio criptografada inválida.');
  const key = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY ?? '', 'base64');
  if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY inválida ou ausente.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]).toString('utf8');
}

const baseUrl = (process.env.ZERNIO_API_BASE_URL ?? 'https://zernio.com/api').replace(/\/$/, '');

async function listAccounts(apiKey) {
  const response = await fetch(`${baseUrl}/v1/accounts`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(25_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`GET /v1/accounts retornou HTTP ${response.status}.`);
  return (Array.isArray(payload.accounts) ? payload.accounts : []).filter((account) => account?.platform === 'instagram');
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) throw new Error('Credenciais do Supabase não encontradas.');
const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

const { data: connections, error: connectionsError } = await supabase
  .from('zernio_connections')
  .select('id, organization_id, label, zernio_profile_id, encrypted_api_key')
  .in('id', [canonicalConnectionId, sourceConnectionId])
  .is('deleted_at', null);
if (connectionsError) throw connectionsError;
if (connections?.length !== 2) throw new Error('As duas conexões Zernio ativas não foram encontradas.');

const canonical = connections.find((connection) => connection.id === canonicalConnectionId);
const source = connections.find((connection) => connection.id === sourceConnectionId);
if (!canonical || !source || canonical.organization_id !== source.organization_id) throw new Error('Conexões inválidas ou pertencentes a organizações diferentes.');

const { data: localProfiles, error: profileError } = await supabase
  .from('instagram_profiles')
  .select('id, organization_id, username, provider, zernio_account_id, zernio_connection_id, zernio_profile_id, deleted_at, created_at, updated_at')
  .eq('organization_id', canonical.organization_id)
  .eq('provider', 'zernio')
  .eq('zernio_account_id', accountId)
  .is('deleted_at', null);
if (profileError) throw profileError;
if (localProfiles?.length !== 1) throw new Error(`Esperado exatamente um perfil local ativo; encontrados ${localProfiles?.length ?? 0}.`);
const localProfileBefore = localProfiles[0];
if (normalizeUsername(localProfileBefore.username) !== username || localProfileBefore.zernio_connection_id !== canonicalConnectionId) {
  throw new Error('O perfil local não corresponde à identidade e à conexão canônica esperadas.');
}

const canonicalApiKey = decryptToken(canonical.encrypted_api_key);
const sourceApiKey = decryptToken(source.encrypted_api_key);
const [canonicalBefore, sourceBefore] = await Promise.all([listAccounts(canonicalApiKey), listAccounts(sourceApiKey)]);
const expectedRemote = (accounts) => accounts.find((account) => remoteId(account) === accountId && normalizeUsername(account.username) === username);
if (!expectedRemote(canonicalBefore) || !expectedRemote(sourceBefore)) throw new Error('O preflight remoto não confirmou a mesma conta nas duas chaves.');

const requestId = `athena-shared-disconnect-${randomUUID()}`;
const deleteResponse = await fetch(`${baseUrl}/v1/accounts/${encodeURIComponent(accountId)}`, {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${sourceApiKey}`, 'x-request-id': requestId },
  cache: 'no-store',
  signal: AbortSignal.timeout(25_000),
});
const deletePayload = await deleteResponse.json().catch(() => ({}));
if (!deleteResponse.ok && deleteResponse.status !== 404) {
  throw new Error(`DELETE retornou HTTP ${deleteResponse.status}: ${String(deletePayload.message ?? deletePayload.error ?? 'sem detalhe')}`);
}

const [canonicalAfter, sourceAfter] = await Promise.all([listAccounts(canonicalApiKey), listAccounts(sourceApiKey)]);
if (canonicalAfter.some((account) => remoteId(account) === accountId) || sourceAfter.some((account) => remoteId(account) === accountId)) {
  throw new Error('A confirmação pós-DELETE ainda encontrou o account ID em pelo menos uma chave.');
}

const { data: localProfileAfter, error: localAfterError } = await supabase
  .from('instagram_profiles')
  .select('id, organization_id, username, provider, zernio_account_id, zernio_connection_id, zernio_profile_id, deleted_at, created_at, updated_at')
  .eq('id', localProfileBefore.id)
  .single();
if (localAfterError) throw localAfterError;
if (JSON.stringify(localProfileAfter) !== JSON.stringify(localProfileBefore)) throw new Error('O perfil local foi alterado inesperadamente durante a operação remota.');

const report = {
  executedAt: new Date().toISOString(),
  identity: username,
  accountId,
  authorization: 'user_authorized_global_disconnect_and_manual_reconnect',
  sourceConnection: { id: source.id, label: source.label, zernioProfileId: source.zernio_profile_id },
  formerCanonicalConnection: { id: canonical.id, label: canonical.label, zernioProfileId: canonical.zernio_profile_id },
  delete: {
    httpStatus: deleteResponse.status,
    requestId: deleteResponse.headers.get('x-request-id') ?? requestId,
    outcome: deleteResponse.status === 404 ? 'already_disconnected_404' : 'remote_deleted',
  },
  verification: {
    absentFromSource: true,
    absentFromFormerCanonical: true,
    localProfilePreservedUnchanged: true,
    localProfileId: localProfileAfter.id,
  },
  nextAction: `Reconectar @${username} manualmente apenas à chave desejada.`,
};

fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
