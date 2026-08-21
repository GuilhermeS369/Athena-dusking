#!/usr/bin/env node

// Diagnóstico somente leitura: nunca imprime API keys nem tokens.
import { createDecipheriv, createHash } from 'node:crypto';
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

function argument(name) {
  return process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1)?.trim() ?? null;
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

function remoteId(account) {
  return account.accountId ?? account._id ?? account.id ?? null;
}

function remoteProfileId(account) {
  return typeof account.profileId === 'string' ? account.profileId : account.profileId?._id ?? null;
}

function credentialFingerprint(apiKey) {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}

function normalizedUsername(value) {
  return typeof value === 'string' ? value.replace(/^@/, '').trim().toLocaleLowerCase('en-US') : null;
}

const organizationName = argument('--organization');
const userEmail = argument('--user-email')?.toLocaleLowerCase('en-US') ?? null;
const usernamesArgument = argument('--usernames');
const allOrganizations = process.argv.includes('--all-organizations');
if (!organizationName && !userEmail && !allOrganizations) {
  throw new Error('Informe --organization=<nome>, --user-email=<email> ou --all-organizations.');
}
if (allOrganizations && (organizationName || userEmail)) {
  throw new Error('Use --all-organizations sozinho; não o combine com --organization nem --user-email.');
}
const requestedUsernames = (usernamesArgument ?? '')
  .split(',')
  .map(normalizedUsername)
  .filter(Boolean);

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) throw new Error('Credenciais do Supabase não encontradas.');
const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

let organization;
if (organizationName) {
  const { data, error } = await supabase.from('organizations').select('id, name').eq('name', organizationName).maybeSingle();
  if (error) throw error;
  organization = data;
} else if (userEmail) {
  const { data: user, error: userError } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (userError) throw userError;
  const account = user.users.find((candidate) => candidate.email?.toLocaleLowerCase('en-US') === userEmail);
  if (!account) throw new Error(`Usuário ${JSON.stringify(userEmail)} não encontrado.`);
  const { data: memberships, error: membershipError } = await supabase
    .from('organization_members')
    .select('organization_id, organizations(id, name)')
    .eq('user_id', account.id)
    .order('updated_at', { ascending: true });
  if (membershipError) throw membershipError;
  if (!memberships?.length) throw new Error(`O usuário ${JSON.stringify(userEmail)} não pertence a nenhuma organização.`);
  if (memberships.length > 1) throw new Error(`O usuário ${JSON.stringify(userEmail)} pertence a ${memberships.length} organizações; informe --organization para selecionar uma.`);
  organization = Array.isArray(memberships[0].organizations) ? memberships[0].organizations[0] : memberships[0].organizations;
}
if (!allOrganizations && !organization) throw new Error(`Organização ${JSON.stringify(organizationName ?? userEmail)} não encontrada.`);

const [{ data: connections, error: connectionsError }, { data: profiles, error: profilesError }, { data: attempts, error: attemptsError }] = await Promise.all([
  allOrganizations
    ? supabase.from('zernio_connections').select('id, organization_id, label, encrypted_api_key, zernio_profile_id, status, last_sync_at, last_error_code, last_error_message, created_at, deleted_at').is('deleted_at', null).order('created_at')
    : supabase.from('zernio_connections').select('id, organization_id, label, encrypted_api_key, zernio_profile_id, status, last_sync_at, last_error_code, last_error_message, created_at, deleted_at').eq('organization_id', organization.id).is('deleted_at', null).order('created_at'),
  allOrganizations
    ? supabase.from('instagram_profiles').select('id, organization_id, instagram_user_id, username, provider, zernio_account_id, zernio_connection_id, zernio_profile_id, deleted_at, created_at, updated_at').eq('provider', 'zernio').order('created_at')
    : supabase.from('instagram_profiles').select('id, organization_id, instagram_user_id, username, provider, zernio_account_id, zernio_connection_id, zernio_profile_id, deleted_at, created_at, updated_at').eq('organization_id', organization.id).eq('provider', 'zernio').order('created_at'),
  allOrganizations
    ? supabase.from('zernio_connection_attempts').select('id, organization_id, zernio_connection_id, status, zernio_profile_id, zernio_account_ids, new_zernio_account_ids, synced_count, created_at, synced_at, failed_at, last_error_message').order('created_at', { ascending: false }).limit(2000)
    : supabase.from('zernio_connection_attempts').select('id, organization_id, zernio_connection_id, status, zernio_profile_id, zernio_account_ids, new_zernio_account_ids, synced_count, created_at, synced_at, failed_at, last_error_message').eq('organization_id', organization.id).order('created_at', { ascending: false }).limit(200),
]);
if (connectionsError || profilesError || attemptsError) throw connectionsError ?? profilesError ?? attemptsError;

const localProfiles = profiles ?? [];
const remoteByConnection = await Promise.all((connections ?? []).map(async (connection) => {
  try {
    const apiKey = decryptToken(connection.encrypted_api_key);
    const response = await fetch(`${(process.env.ZERNIO_API_BASE_URL ?? 'https://zernio.com/api').replace(/\/$/, '')}/v1/accounts`, {
      headers: { Authorization: `Bearer ${apiKey}` }, cache: 'no-store', signal: AbortSignal.timeout(25_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${String(payload.message ?? payload.error ?? 'sem detalhe')}`);
    const visibleAccounts = (Array.isArray(payload.accounts) ? payload.accounts : [])
      .filter((account) => account?.platform === 'instagram')
      .map((account) => ({ accountId: remoteId(account), username: normalizedUsername(account.username), profileId: remoteProfileId(account), active: account.isActive !== false }))
      .filter((account) => account.accountId);
    const accounts = visibleAccounts.filter((account) => account.profileId === connection.zernio_profile_id);
    const rejectedAccounts = visibleAccounts.filter((account) => account.profileId !== connection.zernio_profile_id);
    return {
      connection: { id: connection.id, organizationId: connection.organization_id, label: connection.label, zernioProfileId: connection.zernio_profile_id, status: connection.status, credentialFingerprint: credentialFingerprint(apiKey) },
      accounts,
      rejectedAccounts,
      visibleAccountCount: visibleAccounts.length,
      error: null,
    };
  } catch (error) {
    return { connection: { id: connection.id, organizationId: connection.organization_id, label: connection.label, zernioProfileId: connection.zernio_profile_id, status: connection.status, credentialFingerprint: null }, accounts: [], rejectedAccounts: [], visibleAccountCount: 0, error: error instanceof Error ? error.message : 'Erro desconhecido.' };
  }
}));

const activeProfiles = localProfiles.filter((profile) => !profile.deleted_at);
const by = (items, value) => Object.entries(Object.groupBy(items, value)).filter(([key, rows]) => key && rows.length > 1);
const normalizedLocal = activeProfiles.map((profile) => ({ ...profile, normalizedUsername: normalizedUsername(profile.username) }));
const remoteRows = remoteByConnection.flatMap(({ connection, accounts }) => accounts.map((account) => ({ ...account, organizationId: connection.organizationId, connectionId: connection.id, connectionLabel: connection.label })));

console.log(JSON.stringify({
  checkedAt: new Date().toISOString(),
  scope: allOrganizations ? 'all_organizations' : 'single_organization',
  organization: organization ?? null,
  connections: remoteByConnection.map(({ connection, accounts, rejectedAccounts, visibleAccountCount, error }) => ({
    ...connection,
    remoteInstagramCount: accounts.length,
    visibleInstagramCount: visibleAccountCount,
    remoteAccounts: accounts,
    rejectedAccounts,
    error,
    localProfiles: activeProfiles.filter((profile) => profile.zernio_connection_id === connection.id),
  })),
  findings: {
    duplicateLocalRowsByInstagramIdentity: by(normalizedLocal, (profile) => profile.normalizedUsername),
    duplicateLocalRowsByRemoteAccount: by(activeProfiles, (profile) => profile.zernio_account_id),
    sameRemoteAccountSeenByMultipleKeys: by(remoteRows, (account) => account.accountId),
    sameInstagramUsernameSeenByMultipleKeys: by(remoteRows, (account) => account.username),
    erishimizu67: normalizedLocal.filter((profile) => profile.normalizedUsername === 'erishimizu67'),
  },
  requestedUsernames: requestedUsernames.map((username) => ({
    username,
    remoteMatches: remoteRows.filter((account) => account.username === username),
    localProfiles: normalizedLocal.filter((profile) => profile.normalizedUsername === username),
    recentAttempts: (attempts ?? []).filter((attempt) => {
      const serialized = JSON.stringify(attempt).toLocaleLowerCase('en-US');
      return serialized.includes(username);
    }),
  })),
  attempts: attempts ?? [],
}, null, 2));
