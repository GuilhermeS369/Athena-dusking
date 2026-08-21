#!/usr/bin/env node

// Operação excepcional e destrutiva para uma conta remota comprovadamente
// órfã após uma reassociação local. Nunca move perfis nem cria OAuth.
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
const accountIdOf = (account) => account.accountId ?? account._id ?? account.id ?? null;
const profileIdOf = (account) => typeof account.profileId === 'string' ? account.profileId : account.profileId?._id ?? account.profileId?.id ?? null;

const sourceConnectionId = argument('--source-connection-id');
const accountId = argument('--account-id');
const profileId = argument('--profile-id');
const username = normalizeUsername(argument('--username'));
const expectedLocalProfileId = argument('--expected-local-profile-id');
const outputPath = argument('--output');
if (!process.argv.includes('--apply')) throw new Error('Operação destrutiva bloqueada sem --apply explícito.');
if (!sourceConnectionId || !accountId || !profileId || !username || !expectedLocalProfileId || !outputPath) {
  throw new Error('Informe conexão de origem, account/profile IDs, username, perfil local esperado e arquivo de evidência.');
}

function decryptToken(payload) {
  const [version, ivValue, tagValue, encryptedValue] = payload.split('.');
  if (version !== 'v1' || !ivValue || !tagValue || !encryptedValue) throw new Error('Chave Zernio criptografada inválida.');
  const key = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY ?? '', 'base64');
  if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY inválida ou ausente.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]).toString('utf8');
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) throw new Error('Credenciais do Supabase não encontradas.');
const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
const baseUrl = (process.env.ZERNIO_API_BASE_URL ?? 'https://zernio.com/api').replace(/\/$/, '');

async function listAccounts(apiKey) {
  const response = await fetch(`${baseUrl}/v1/accounts`, { headers: { Authorization: `Bearer ${apiKey}` }, cache: 'no-store', signal: AbortSignal.timeout(25_000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`GET /v1/accounts retornou HTTP ${response.status}.`);
  return (Array.isArray(payload.accounts) ? payload.accounts : []).filter((account) => account?.platform === 'instagram');
}

const { data: source, error: sourceError } = await supabase
  .from('zernio_connections')
  .select('id, organization_id, label, zernio_profile_id, encrypted_api_key')
  .eq('id', sourceConnectionId)
  .is('deleted_at', null)
  .single();
if (sourceError) throw sourceError;

const { data: localProfiles, error: localError } = await supabase
  .from('instagram_profiles')
  .select('id, username, provider, zernio_account_id, zernio_profile_id, zernio_connection_id, deleted_at, created_at, updated_at')
  .eq('organization_id', source.organization_id)
  .eq('provider', 'zernio')
  .is('deleted_at', null);
if (localError) throw localError;
const identityRows = localProfiles.filter((row) => normalizeUsername(row.username) === username);
if (identityRows.length !== 1) throw new Error(`Esperado um único perfil local ativo para @${username}; encontrados ${identityRows.length}.`);
const localProfileBefore = identityRows[0];
if (localProfileBefore.id !== expectedLocalProfileId) throw new Error('O perfil local atual não corresponde ao perfil autorizado para a reassociação.');
if (localProfileBefore.zernio_account_id === accountId || localProfileBefore.zernio_profile_id === profileId) {
  throw new Error('A conta remota ainda é o vínculo local canônico; a remoção é insegura.');
}

const apiKey = decryptToken(source.encrypted_api_key);
const accountsBefore = await listAccounts(apiKey);
const orphan = accountsBefore.find((account) => accountIdOf(account) === accountId);
if (!orphan || normalizeUsername(orphan.username) !== username || profileIdOf(orphan) !== profileId) {
  throw new Error('O preflight remoto não confirmou exatamente a conta órfã esperada.');
}

const requestId = `athena-orphan-disconnect-${randomUUID()}`;
const deleteResponse = await fetch(`${baseUrl}/v1/accounts/${encodeURIComponent(accountId)}`, {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${apiKey}`, 'x-request-id': requestId },
  cache: 'no-store',
  signal: AbortSignal.timeout(25_000),
});
const deletePayload = await deleteResponse.json().catch(() => ({}));
if (!deleteResponse.ok && deleteResponse.status !== 404) throw new Error(`DELETE retornou HTTP ${deleteResponse.status}: ${String(deletePayload.message ?? deletePayload.error ?? 'sem detalhe')}`);

const accountsAfter = await listAccounts(apiKey);
if (accountsAfter.some((account) => accountIdOf(account) === accountId)) throw new Error('A confirmação pós-DELETE ainda encontrou a conta remota órfã.');
const { data: localProfileAfter, error: afterError } = await supabase
  .from('instagram_profiles')
  .select('id, username, provider, zernio_account_id, zernio_profile_id, zernio_connection_id, deleted_at, created_at, updated_at')
  .eq('id', localProfileBefore.id)
  .single();
if (afterError) throw afterError;
if (JSON.stringify(localProfileAfter) !== JSON.stringify(localProfileBefore)) throw new Error('O perfil local foi alterado inesperadamente durante a remoção remota.');

const report = {
  executedAt: new Date().toISOString(),
  operation: 'remove_proven_orphaned_remote_zernio_account',
  sourceConnection: { id: source.id, label: source.label, zernioProfileId: source.zernio_profile_id },
  orphan: { accountId, username, zernioProfileId: profileId, remoteBefore: orphan },
  localCanonicalProfilePreserved: localProfileAfter,
  delete: { httpStatus: deleteResponse.status, requestId: deleteResponse.headers.get('x-request-id') ?? requestId, outcome: deleteResponse.status === 404 ? 'already_absent_404' : 'remote_deleted' },
  verification: { orphanAbsentFromRemoteInventory: true, localProfilePreservedUnchanged: true, remoteInstagramCountBefore: accountsBefore.length, remoteInstagramCountAfter: accountsAfter.length },
};
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
