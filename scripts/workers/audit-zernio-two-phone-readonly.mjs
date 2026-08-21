#!/usr/bin/env node

// Auditoria estritamente read-only do incidente OAuth Zernio em dois celulares.
// Não imprime credenciais, tokens, state OAuth, cookies ou códigos de autorização.
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

const ORGANIZATION_ID = '695be08f-3084-4046-a91d-9052b2a1582b';
const CONNECTION_ID = '8f08e8d9-6c49-44df-8a1a-e949209185f4';
const TARGET_ACCOUNT_ID = '6a82575377555aae01712203';
const TARGET_PROFILE_ID = '6a8222bbeede9a41be970f66';
const TARGET_USERNAME = 'phoenixzen3749';
const CUTOFF = '2026-08-17T01:18:00.000Z';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) throw new Error('Credenciais do Supabase não encontradas.');
const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

function decryptToken(payload) {
  const [version, ivValue, tagValue, encryptedValue] = String(payload ?? '').split('.');
  if (version !== 'v1' || !ivValue || !tagValue || !encryptedValue) throw new Error('Chave Zernio criptografada inválida.');
  const key = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY ?? '', 'base64');
  if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY inválida ou ausente.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]).toString('utf8');
}

function isSensitiveKey(key) {
  return /token|secret|password|cookie|authorization|encrypted|api.?key/i.test(key)
    || /(^|_)state$/i.test(key)
    || /(^|_)(authorization_?)?code$/i.test(key);
}

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
    key,
    isSensitiveKey(key) ? '[REDACTED]' : sanitize(nested),
  ]));
}

function timestampValues(row) {
  return Object.entries(row ?? {})
    .filter(([key, value]) => /(_at|At)$/.test(key) && typeof value === 'string')
    .map(([, value]) => Date.parse(value))
    .filter(Number.isFinite);
}

function changedAfterCutoff(row) {
  return timestampValues(row).some((value) => value >= Date.parse(CUTOFF));
}

async function optional(label, builder) {
  const { data, error } = await builder;
  return error
    ? { label, rows: [], unavailable: error.message }
    : { label, rows: sanitize(data ?? []), unavailable: null };
}

const sections = await Promise.all([
  optional('attempts', supabase.from('zernio_connection_attempts').select('*').eq('organization_id', ORGANIZATION_ID).order('created_at', { ascending: false }).limit(100)),
  optional('intents', supabase.from('zernio_connection_intents').select('*').eq('organization_id', ORGANIZATION_ID).order('created_at', { ascending: false }).limit(100)),
  optional('oauthTurns', supabase.from('zernio_oauth_turns').select('*').eq('organization_id', ORGANIZATION_ID).order('created_at', { ascending: false }).limit(100)),
  optional('reservations', supabase.from('zernio_connection_slot_reservations').select('*').eq('organization_id', ORGANIZATION_ID).order('created_at', { ascending: false }).limit(100)),
  optional('accountClaims', supabase.from('zernio_addition_account_claims').select('*').eq('organization_id', ORGANIZATION_ID).order('created_at', { ascending: false }).limit(100)),
  optional('additionLocks', supabase.from('zernio_addition_organization_locks').select('*').eq('organization_id', ORGANIZATION_ID)),
  optional('operationLocks', supabase.from('zernio_connection_operation_locks').select('*').eq('organization_id', ORGANIZATION_ID)),
  optional('syncLocks', supabase.from('zernio_organization_sync_locks').select('*').eq('organization_id', ORGANIZATION_ID)),
  optional('importLocks', supabase.from('zernio_connection_import_locks').select('*').eq('organization_id', ORGANIZATION_ID)),
  optional('profilesOrganization', supabase.from('instagram_profiles').select('*').eq('organization_id', ORGANIZATION_ID).eq('provider', 'zernio').order('created_at', { ascending: false })),
  optional('profilesGlobalByAccount', supabase.from('instagram_profiles').select('*').eq('zernio_account_id', TARGET_ACCOUNT_ID).order('created_at', { ascending: false })),
  optional('profilesGlobalByRemoteProfile', supabase.from('instagram_profiles').select('*').eq('zernio_profile_id', TARGET_PROFILE_ID).order('created_at', { ascending: false })),
  optional('profilesGlobalByUsername', supabase.from('instagram_profiles').select('*').ilike('username', TARGET_USERNAME).order('created_at', { ascending: false })),
  optional('syncBatches', supabase.from('zernio_sync_batches').select('*').eq('organization_id', ORGANIZATION_ID).order('created_at', { ascending: false }).limit(50)),
  optional('syncBatchItems', supabase.from('zernio_sync_batch_items').select('*').eq('organization_id', ORGANIZATION_ID).order('created_at', { ascending: false }).limit(200)),
  optional('syncLogsByAccount', supabase.from('zernio_sync_log_items').select('*').eq('organization_id', ORGANIZATION_ID).eq('zernio_account_id', TARGET_ACCOUNT_ID).order('created_at', { ascending: false }).limit(200)),
  optional('syncLogsRecent', supabase.from('zernio_sync_log_items').select('*').eq('organization_id', ORGANIZATION_ID).gte('created_at', CUTOFF).order('created_at', { ascending: false }).limit(500)),
  optional('disconnectionIncidents', supabase.from('zernio_profile_disconnection_incidents').select('*').eq('organization_id', ORGANIZATION_ID).order('created_at', { ascending: false }).limit(200)),
  optional('duplicateResolutions', supabase.from('zernio_profile_duplicate_resolutions').select('*').eq('organization_id', ORGANIZATION_ID).order('resolved_at', { ascending: false }).limit(200)),
  optional('duplicateJobs', supabase.from('zernio_profile_recycling_jobs').select('*').eq('organization_id', ORGANIZATION_ID).order('created_at', { ascending: false }).limit(200)),
  optional('inventoryObservations', supabase.from('zernio_shared_inventory_observations').select('*').eq('organization_id', ORGANIZATION_ID).order('created_at', { ascending: false }).limit(500)),
]);

const byLabel = Object.fromEntries(sections.map((section) => [section.label, section]));
const attempts = byLabel.attempts.rows;
const relatedAttemptIds = attempts
  .filter((row) => row.zernio_connection_id === CONNECTION_ID || JSON.stringify(row).includes(TARGET_ACCOUNT_ID))
  .map((row) => row.id);
const relatedIntentIds = attempts.filter((row) => relatedAttemptIds.includes(row.id)).map((row) => row.zernio_connection_intent_id).filter(Boolean);
const relatedReservationIds = attempts.filter((row) => relatedAttemptIds.includes(row.id)).map((row) => row.zernio_slot_reservation_id).filter(Boolean);

const { data: connectionRaw, error: connectionError } = await supabase
  .from('zernio_connections')
  .select('*')
  .eq('id', CONNECTION_ID)
  .eq('organization_id', ORGANIZATION_ID)
  .single();
if (connectionError) throw connectionError;
const apiKey = decryptToken(connectionRaw.encrypted_api_key);
const remoteResponse = await fetch(`${(process.env.ZERNIO_API_BASE_URL ?? 'https://zernio.com/api').replace(/\/$/, '')}/v1/accounts`, {
  headers: { Authorization: `Bearer ${apiKey}` }, cache: 'no-store', signal: AbortSignal.timeout(25_000),
});
const remotePayload = await remoteResponse.json().catch(() => ({}));
const remoteAccounts = (Array.isArray(remotePayload.accounts) ? remotePayload.accounts : [])
  .filter((account) => account?.platform === 'instagram')
  .map((account) => ({
    accountId: account.accountId ?? account._id ?? account.id ?? null,
    username: account.username ?? null,
    profileId: typeof account.profileId === 'string' ? account.profileId : account.profileId?._id ?? null,
    isActive: account.isActive ?? null,
    needsReconnection: account.needsReconnection ?? null,
    createdAt: account.createdAt ?? account.created_at ?? null,
    updatedAt: account.updatedAt ?? account.updated_at ?? null,
  }));

const relevant = {
  attempts: attempts.filter((row) => relatedAttemptIds.includes(row.id)),
  intents: byLabel.intents.rows.filter((row) => relatedIntentIds.includes(row.id) || JSON.stringify(row).includes(TARGET_ACCOUNT_ID)),
  oauthTurns: byLabel.oauthTurns.rows.filter((row) => relatedAttemptIds.includes(row.zernio_connection_attempt_id) || relatedIntentIds.includes(row.zernio_connection_intent_id)),
  reservations: byLabel.reservations.rows.filter((row) => relatedReservationIds.includes(row.id) || relatedIntentIds.includes(row.zernio_connection_intent_id) || row.zernio_connection_id === CONNECTION_ID),
  accountClaims: byLabel.accountClaims.rows.filter((row) => relatedAttemptIds.includes(row.attempt_id) || row.zernio_account_id === TARGET_ACCOUNT_ID),
};

const result = {
  checkedAt: new Date().toISOString(),
  readOnly: true,
  cutoff: CUTOFF,
  target: { organizationId: ORGANIZATION_ID, connectionId: CONNECTION_ID, accountId: TARGET_ACCOUNT_ID, profileId: TARGET_PROFILE_ID, username: TARGET_USERNAME },
  connection: {
    ...sanitize(connectionRaw),
    credentialFingerprint: createHash('sha256').update(apiKey).digest('hex').slice(0, 16),
  },
  remoteInventory: {
    fetchedAt: new Date().toISOString(),
    httpStatus: remoteResponse.status,
    accounts: remoteAccounts,
    targetAccount: remoteAccounts.filter((row) => row.accountId === TARGET_ACCOUNT_ID),
    canonicalProfileAccounts: remoteAccounts.filter((row) => row.profileId === TARGET_PROFILE_ID),
  },
  relevant,
  recordsChangedAfterCutoff: Object.fromEntries(sections.map((section) => [section.label, section.rows.filter(changedAfterCutoff)])),
  profiles: {
    organizationOnConnection: byLabel.profilesOrganization.rows.filter((row) => row.zernio_connection_id === CONNECTION_ID),
    globalByAccount: byLabel.profilesGlobalByAccount.rows,
    globalByRemoteProfile: byLabel.profilesGlobalByRemoteProfile.rows,
    globalByUsername: byLabel.profilesGlobalByUsername.rows,
  },
  syncAndIncidentEvidence: {
    syncBatches: byLabel.syncBatches.rows.filter((row) => changedAfterCutoff(row) || row.zernio_connection_id === CONNECTION_ID),
    syncBatchItems: byLabel.syncBatchItems.rows.filter((row) => changedAfterCutoff(row) || row.zernio_connection_id === CONNECTION_ID),
    syncLogsByAccount: byLabel.syncLogsByAccount.rows,
    syncLogsRecent: byLabel.syncLogsRecent.rows,
    disconnectionIncidents: byLabel.disconnectionIncidents.rows.filter((row) => changedAfterCutoff(row) || JSON.stringify(row).includes(TARGET_ACCOUNT_ID) || JSON.stringify(row).includes(TARGET_USERNAME)),
    duplicateResolutions: byLabel.duplicateResolutions.rows.filter((row) => changedAfterCutoff(row) || JSON.stringify(row).includes(TARGET_ACCOUNT_ID) || JSON.stringify(row).includes(TARGET_USERNAME)),
    duplicateJobs: byLabel.duplicateJobs.rows.filter((row) => changedAfterCutoff(row) || JSON.stringify(row).includes(TARGET_ACCOUNT_ID) || JSON.stringify(row).includes(TARGET_USERNAME)),
    inventoryObservations: byLabel.inventoryObservations.rows.filter((row) => changedAfterCutoff(row) || JSON.stringify(row).includes(TARGET_ACCOUNT_ID) || row.zernio_connection_id === CONNECTION_ID),
  },
  locks: {
    addition: byLabel.additionLocks,
    operation: byLabel.operationLocks,
    sync: byLabel.syncLocks,
    import: byLabel.importLocks,
  },
  unavailableSections: sections.filter((section) => section.unavailable).map(({ label, unavailable }) => ({ label, unavailable })),
};

console.log(JSON.stringify(result, null, 2));
