#!/usr/bin/env node

import { createDecipheriv } from 'node:crypto';
import fs from 'node:fs';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

for (const filePath of ['.env.local', '.env.worker.deploy']) {
  if (!fs.existsSync(filePath)) continue;
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
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
  const encryptionKey = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY ?? '', 'base64');
  if (encryptionKey.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY inválida ou ausente.');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]).toString('utf8');
}

function accountId(account) {
  return account.accountId ?? account._id ?? account.id ?? null;
}

function profileId(account) {
  return typeof account.profileId === 'string' ? account.profileId : account.profileId?._id ?? account.profileId?.id ?? null;
}

const label = argument('--label');
const reconcile = process.argv.includes('--reconcile');
const repairLocalMissing = process.argv.includes('--repair-local-missing');
if (!label) throw new Error('Informe --label=<rótulo da conexão Zernio>.');
if (reconcile && repairLocalMissing) throw new Error('Use somente um modo de reparo por vez.');

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const zernioBaseUrl = process.env.ZERNIO_API_BASE_URL ?? 'https://zernio.com/api';
if (!url || !serviceRoleKey) throw new Error('Credenciais do Supabase não encontradas.');

const supabase = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
const { data: connections, error: connectionError } = await supabase
  .from('zernio_connections')
  .select('id, organization_id, label, encrypted_api_key, zernio_profile_id, status, created_by, last_checked_at, last_sync_at, last_error_code, last_error_message, metadata')
  .ilike('label', label)
  .is('deleted_at', null);
if (connectionError) throw connectionError;
if (!connections?.length) throw new Error(`Nenhuma conexão ativa encontrada com o rótulo ${JSON.stringify(label)}.`);
if (connections.length > 1) throw new Error(`Foram encontradas ${connections.length} conexões ativas com este rótulo; não é seguro continuar.`);

const connection = connections[0];
const apiKey = decryptToken(connection.encrypted_api_key);
const response = await fetch(`${zernioBaseUrl.replace(/\/$/, '')}/v1/accounts`, {
  headers: { Authorization: `Bearer ${apiKey}` },
  cache: 'no-store',
  signal: AbortSignal.timeout(25_000),
});
const payload = await response.json().catch(() => ({}));
if (!response.ok) throw new Error(`A Zernio recusou a listagem de contas (HTTP ${response.status}): ${String(payload.message ?? payload.error ?? 'sem detalhe')}`);

const zernioAccounts = Array.isArray(payload.accounts) ? payload.accounts : [];
const instagramAccounts = zernioAccounts
  .filter((account) => account?.platform === 'instagram')
  .map((account) => ({
    accountId: accountId(account),
    username: typeof account.username === 'string' ? account.username.replace(/^@/, '') : null,
    profileId: profileId(account),
    active: account.isActive !== false,
  }))
  .filter((account) => account.accountId);

const { data: athenaProfiles, error: profileError } = await supabase
  .from('instagram_profiles')
  .select('id, instagram_user_id, username, status, provider, zernio_account_id, zernio_profile_id, zernio_connection_id, deleted_at, created_at, updated_at')
  .eq('organization_id', connection.organization_id)
  .eq('provider', 'zernio')
  .eq('zernio_connection_id', connection.id)
  .order('created_at');
if (profileError) throw profileError;

const { data: attempts, error: attemptError } = await supabase
  .from('zernio_connection_attempts')
  .select('id, status, zernio_profile_id, zernio_account_ids, new_zernio_account_ids, synced_count, created_at, synced_at, failed_at, last_error_message, diagnostic')
  .eq('organization_id', connection.organization_id)
  .eq('zernio_connection_id', connection.id)
  .order('created_at', { ascending: false })
  .limit(30);
if (attemptError) throw attemptError;

const athenaAccountIds = new Set((athenaProfiles ?? []).filter((profile) => !profile.deleted_at).map((profile) => profile.zernio_account_id).filter(Boolean));
const zernioAccountIds = new Set(instagramAccounts.map((account) => account.accountId));
let reconciliation = null;
let localMissingRepair = null;
if (reconcile) {
  const rows = zernioAccounts
    .filter((account) => account?.platform === 'instagram' && accountId(account))
    .map((account) => {
      const id = accountId(account);
      const username = typeof account.username === 'string' && account.username.replace(/^@/, '').trim()
        ? account.username.replace(/^@/, '').trim()
        : id;
      const pictureCandidates = [account.profilePicture, account.profilePictureUrl, account.profileImageUrl, account.profileImage, account.avatarUrl, account.avatar, account.picture];
      const profilePictureUrl = pictureCandidates.find((value) => typeof value === 'string' && /^https?:\/\//i.test(value)) ?? null;
      return {
        organization_id: connection.organization_id,
        instagram_user_id: `zernio:${id}`,
        username,
        display_name: account.displayName ?? username,
        profile_picture_url: profilePictureUrl,
        account_type: 'Zernio Instagram',
        capabilities: {
          zernio_content_publish: true,
          zernio_instagram_feed: true,
          zernio_instagram_reels: true,
          zernio_instagram_stories: true,
          zernio_instagram_carousel: true,
        },
        encrypted_access_token: null,
        token_expires_at: null,
        status: account.isActive === false ? 'offline' : 'online',
        deleted_at: null,
        created_by: connection.created_by,
        provider: 'zernio',
        zernio_profile_id: profileId(account) ?? connection.zernio_profile_id,
        zernio_account_id: id,
        zernio_connection_id: connection.id,
        zernio_account_metadata: account,
      };
    });
  const { data: upsertedProfiles, error: reconcileError } = await supabase
    .from('instagram_profiles')
    .upsert(rows, { onConflict: 'organization_id,instagram_user_id' })
    .select('id, username, status, zernio_account_id, zernio_profile_id, zernio_connection_id');
  if (reconcileError) throw reconcileError;
  const now = new Date().toISOString();
  const { error: connectionUpdateError } = await supabase
    .from('zernio_connections')
    .update({ status: 'online', last_checked_at: now, last_success_at: now, last_sync_at: now, last_error_code: null, last_error_message: null })
    .eq('id', connection.id)
    .eq('organization_id', connection.organization_id);
  if (connectionUpdateError) throw connectionUpdateError;
  reconciliation = { action: 'upserted_existing_zernio_accounts_without_deleting_any_account_or_profile', profiles: upsertedProfiles ?? [] };
}
if (repairLocalMissing) {
  // Repara apenas contas que pertencem comprovadamente ao profile canônico
  // desta chave e ainda não existem localmente. Contas expostas pela mesma API
  // sob outro profile continuam fora do escopo, para não atravessar conexões.
  const canonicalAccounts = instagramAccounts.filter((account) => account.profileId === connection.zernio_profile_id);
  const missingCanonicalAccounts = canonicalAccounts.filter((account) => !athenaAccountIds.has(account.accountId));
  if (missingCanonicalAccounts.length) {
    const rows = missingCanonicalAccounts.map((account) => ({
      organization_id: connection.organization_id,
      instagram_user_id: `zernio:${account.accountId}`,
      username: account.username ?? account.accountId,
      display_name: account.username ?? account.accountId,
      account_type: 'Zernio Instagram',
      capabilities: {
        zernio_content_publish: true,
        zernio_instagram_feed: true,
        zernio_instagram_reels: true,
        zernio_instagram_stories: true,
        zernio_instagram_carousel: true,
      },
      status: account.active ? 'online' : 'offline',
      deleted_at: null,
      created_by: connection.created_by,
      provider: 'zernio',
      zernio_profile_id: connection.zernio_profile_id,
      zernio_account_id: account.accountId,
      zernio_connection_id: connection.id,
    }));
    const { data: upsertedProfiles, error: repairError } = await supabase
      .from('instagram_profiles')
      .upsert(rows, { onConflict: 'organization_id,instagram_user_id' })
      .select('id, username, status, zernio_account_id, zernio_profile_id, zernio_connection_id');
    if (repairError) throw repairError;
    localMissingRepair = { action: 'upserted_only_missing_accounts_from_canonical_profile_without_deleting_accounts_or_profiles', profiles: upsertedProfiles ?? [] };
  } else {
    localMissingRepair = { action: 'no_canonical_account_missing_locally', profiles: [] };
  }
}
const safeConnection = {
  id: connection.id,
  organizationId: connection.organization_id,
  label: connection.label,
  zernioProfileId: connection.zernio_profile_id,
  status: connection.status,
  lastCheckedAt: connection.last_checked_at,
  lastSyncAt: connection.last_sync_at,
  lastErrorCode: connection.last_error_code,
  lastErrorMessage: connection.last_error_message,
};

console.log(JSON.stringify({
  checkedAt: new Date().toISOString(),
  connection: safeConnection,
  zernio: {
    totalAccounts: zernioAccounts.length,
    instagramAccounts,
    distinctProfileIds: [...new Set(instagramAccounts.map((account) => account.profileId).filter(Boolean))],
  },
  athena: {
    profiles: athenaProfiles ?? [],
    missingFromAthena: instagramAccounts.filter((account) => !athenaAccountIds.has(account.accountId)),
    notReturnedByZernio: (athenaProfiles ?? []).filter((profile) => !profile.deleted_at && profile.zernio_account_id && !zernioAccountIds.has(profile.zernio_account_id)),
  },
  reconciliation,
  localMissingRepair,
  attempts: attempts ?? [],
}, null, 2));
