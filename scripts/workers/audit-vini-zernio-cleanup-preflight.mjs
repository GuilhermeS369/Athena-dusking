#!/usr/bin/env node

// Preflight estritamente read-only para classificar resíduos Zernio da organização Vini.
// Nunca imprime tokens/API keys: credenciais são representadas apenas por SHA-256 truncado.
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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

const ORGANIZATION_ID = '695be08f-3084-4046-a91d-9052b2a1582b';
const DIAGNOSTIC_PATH = '.zernio-vini-farmando-cash-pre-cleanup-2026-08-16.json';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) throw new Error('Credenciais do Supabase não encontradas.');
if (!fs.existsSync(DIAGNOSTIC_PATH)) throw new Error(`Diagnóstico base ausente: ${DIAGNOSTIC_PATH}`);

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function decryptToken(payload) {
  const [version, ivValue, tagValue, encryptedValue] = payload.split('.');
  if (version !== 'v1' || !ivValue || !tagValue || !encryptedValue) {
    throw new Error('Chave Zernio criptografada inválida.');
  }
  const key = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY ?? '', 'base64');
  if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY inválida ou ausente.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function fingerprint(encryptedApiKey) {
  const apiKey = decryptToken(encryptedApiKey);
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function withoutSecrets(row) {
  if (!row || typeof row !== 'object') return row;
  const { encrypted_api_key: _encryptedApiKey, access_token: _accessToken, ...safe } = row;
  return safe;
}

async function required(label, builder) {
  const { data, error } = await builder;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data ?? [];
}

async function optional(label, builder) {
  const { data, error } = await builder;
  if (error) return { label, rows: [], unavailable: error.message };
  return { label, rows: data ?? [], unavailable: null };
}

async function allRows(label, table, configure, pageSize = 1000) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    let query = supabase.from(table).select('*').range(from, from + pageSize - 1);
    query = configure(query);
    const { data, error } = await query;
    if (error) throw new Error(`${label}: ${error.message}`);
    rows.push(...(data ?? []));
    if ((data ?? []).length < pageSize) return rows;
  }
}

const baseDiagnostic = JSON.parse(fs.readFileSync(DIAGNOSTIC_PATH, 'utf8'));
const conflictingConnections = baseDiagnostic.connections.filter(
  (connection) => connection.rejectedAccounts?.length > 0,
);
const rejectedAccounts = conflictingConnections.flatMap((connection) =>
  connection.rejectedAccounts.map((account) => ({
    ...account,
    observedOnConnectionId: connection.id,
    observedOnConnectionLabel: connection.label,
    observedCanonicalProfileId: connection.zernioProfileId,
  })),
);
const targetAccountIds = unique(rejectedAccounts.map((account) => account.accountId));
const targetProfileIds = unique(rejectedAccounts.map((account) => account.profileId));
const targetUsernames = unique(rejectedAccounts.map((account) => account.username));
const conflictingConnectionIds = unique(conflictingConnections.map((connection) => connection.id));
const acceptedAccounts = baseDiagnostic.connections.flatMap((connection) =>
  (connection.remoteAccounts ?? []).map((account) => ({
    ...account,
    observedOnConnectionId: connection.id,
    observedOnConnectionLabel: connection.label,
    observedCanonicalProfileId: connection.zernioProfileId,
  })),
);
const acceptedAccountIds = unique(acceptedAccounts.map((account) => account.accountId));
const acceptedUsernames = unique(acceptedAccounts.map((account) => account.username));

const [
  organization,
  organizationConnectionsRaw,
  allConnectionsRaw,
  organizationProfiles,
  globalProfilesByAccount,
  globalProfilesByRemoteProfile,
  globalProfilesByUsername,
  globalAcceptedProfilesByAccount,
  globalAcceptedProfilesByUsername,
] = await Promise.all([
  required('organization', supabase.from('organizations').select('*').eq('id', ORGANIZATION_ID).single()),
  required('organization connections', supabase.from('zernio_connections').select('*').eq('organization_id', ORGANIZATION_ID).order('created_at')),
  required('all connections', supabase.from('zernio_connections').select('*').order('created_at')),
  required('organization profiles', supabase.from('instagram_profiles').select('*').eq('organization_id', ORGANIZATION_ID).eq('provider', 'zernio').order('created_at')),
  required('global profiles by account', supabase.from('instagram_profiles').select('*').in('zernio_account_id', targetAccountIds).order('created_at')),
  required('global profiles by remote profile', supabase.from('instagram_profiles').select('*').in('zernio_profile_id', targetProfileIds).order('created_at')),
  required('global profiles by username', supabase.from('instagram_profiles').select('*').in('username', targetUsernames).order('created_at')),
  required('global accepted profiles by account', supabase.from('instagram_profiles').select('*').in('zernio_account_id', acceptedAccountIds).order('created_at')),
  required('global accepted profiles by username', supabase.from('instagram_profiles').select('*').in('username', acceptedUsernames).order('created_at')),
]);

const allGlobalZernioProfiles = await allRows(
  'all global Zernio profiles',
  'instagram_profiles',
  (query) => query.eq('provider', 'zernio').order('created_at'),
);

const organizationConnections = organizationConnectionsRaw.map((connection) => ({
  ...withoutSecrets(connection),
  credentialFingerprint: fingerprint(connection.encrypted_api_key),
}));
const allConnections = allConnectionsRaw.map((connection) => ({
  ...withoutSecrets(connection),
  credentialFingerprint: fingerprint(connection.encrypted_api_key),
}));

const activeTargetProfiles = organizationProfiles.filter(
  (profile) => !profile.deleted_at && targetAccountIds.includes(profile.zernio_account_id),
);
const targetLocalProfileIds = unique([
  ...activeTargetProfiles.map((profile) => profile.id),
  ...globalProfilesByAccount.map((profile) => profile.id),
]);

const latestBatches = await required(
  'sync batches',
  supabase.from('zernio_sync_batches').select('*').eq('organization_id', ORGANIZATION_ID).order('created_at', { ascending: false }).limit(10),
);
const latestBatchIds = latestBatches.map((batch) => batch.id);

const optionalQueries = await Promise.all([
  optional('syncBatchItems', supabase.from('zernio_sync_batch_items').select('*').eq('organization_id', ORGANIZATION_ID).in('batch_id', latestBatchIds).order('created_at', { ascending: false })),
  optional('syncLogItems', supabase.from('zernio_sync_log_items').select('*').eq('organization_id', ORGANIZATION_ID).in('batch_id', latestBatchIds).order('created_at', { ascending: false })),
  optional('connectionAttempts', supabase.from('zernio_connection_attempts').select('*').eq('organization_id', ORGANIZATION_ID).order('created_at', { ascending: false }).limit(500)),
  optional('connectionIntents', supabase.from('zernio_connection_intents').select('*').eq('organization_id', ORGANIZATION_ID).order('created_at', { ascending: false }).limit(500)),
  optional('oauthTurns', supabase.from('zernio_oauth_turns').select('*').eq('organization_id', ORGANIZATION_ID).order('created_at', { ascending: false }).limit(500)),
  optional('slotReservations', supabase.from('zernio_connection_slot_reservations').select('*').eq('organization_id', ORGANIZATION_ID).order('created_at', { ascending: false }).limit(500)),
  optional('connectionOperationLocks', supabase.from('zernio_connection_operation_locks').select('*').eq('organization_id', ORGANIZATION_ID)),
  optional('organizationSyncLocks', supabase.from('zernio_organization_sync_locks').select('*').eq('organization_id', ORGANIZATION_ID)),
  optional('connectionImportLocks', supabase.from('zernio_connection_import_locks').select('*').eq('organization_id', ORGANIZATION_ID)),
  optional('groupMemberships', supabase.from('profile_group_members').select('*, profile_groups(*)').in('profile_id', targetLocalProfileIds)),
  optional('disconnectionIncidents', supabase.from('zernio_profile_disconnection_incidents').select('*').eq('organization_id', ORGANIZATION_ID).order('created_at', { ascending: false }).limit(500)),
  optional('recyclingJobs', supabase.from('zernio_profile_recycling_jobs').select('*, zernio_profile_disconnection_incidents(*)').eq('organization_id', ORGANIZATION_ID).order('created_at', { ascending: false }).limit(500)),
  optional('sharedInventoryObservations', supabase.from('zernio_shared_inventory_observations').select('*').eq('organization_id', ORGANIZATION_ID).order('created_at', { ascending: false }).limit(1000)),
  optional('duplicateResolutions', supabase.from('zernio_profile_duplicate_resolutions').select('*').eq('organization_id', ORGANIZATION_ID).order('resolved_at', { ascending: false }).limit(500)),
  optional('publicationItems', supabase.from('publication_items').select('id, profile_id, status, execute_at, last_error_code, last_error_message, created_at, updated_at').in('profile_id', targetLocalProfileIds).order('created_at', { ascending: false }).limit(1000)),
  optional('analyticsJobs', supabase.from('profile_analytics_refresh_jobs').select('*').in('profile_id', targetLocalProfileIds).order('created_at', { ascending: false }).limit(1000)),
]);

const sections = Object.fromEntries(optionalQueries.map((section) => [section.label, section]));
const latestBatchItems = sections.syncBatchItems.rows;
const latestBatchLogs = sections.syncLogItems.rows;
const now = Date.now();
const isFuture = (value) => value && new Date(value).getTime() > now;

const fingerprints = Object.groupBy(allConnections, (connection) => connection.credentialFingerprint);
const repeatedCredentials = Object.entries(fingerprints)
  .filter(([, rows]) => rows.length > 1)
  .map(([credentialFingerprint, rows]) => ({
    credentialFingerprint,
    connections: rows,
  }));

const canonicalConnectionByRemoteProfile = targetProfileIds.map((remoteProfileId) => ({
  remoteProfileId,
  matchingConnections: allConnections.filter(
    (connection) => !connection.deleted_at && connection.zernio_profile_id === remoteProfileId,
  ),
}));

const targetClassification = rejectedAccounts.map((remote) => {
  const localRows = organizationProfiles.filter(
    (profile) => profile.zernio_account_id === remote.accountId || profile.username === remote.username,
  );
  const globalRows = unique([
    ...globalProfilesByAccount.filter((profile) => profile.zernio_account_id === remote.accountId).map((profile) => profile.id),
    ...globalProfilesByRemoteProfile.filter((profile) => profile.zernio_profile_id === remote.profileId).map((profile) => profile.id),
    ...globalProfilesByUsername.filter((profile) => profile.username === remote.username).map((profile) => profile.id),
  ]).map((profileId) =>
    [...globalProfilesByAccount, ...globalProfilesByRemoteProfile, ...globalProfilesByUsername].find(
      (profile) => profile.id === profileId,
    ),
  );
  const canonicalConnections = allConnections.filter(
    (connection) => !connection.deleted_at && connection.zernio_profile_id === remote.profileId,
  );
  const memberships = sections.groupMemberships.rows.filter((membership) =>
    localRows.some((profile) => profile.id === membership.profile_id),
  );
  const publicationItems = sections.publicationItems.rows.filter((item) =>
    localRows.some((profile) => profile.id === item.profile_id),
  );
  return {
    remote,
    localRows,
    globalRows,
    canonicalConnections,
    memberships,
    publicationSummary: {
      total: publicationItems.length,
      nonTerminal: publicationItems.filter((item) => !['published', 'failed', 'cancelled', 'ignored'].includes(item.status)).length,
      statuses: Object.fromEntries(Object.entries(Object.groupBy(publicationItems, (item) => item.status)).map(([status, rows]) => [status, rows.length])),
    },
    preliminaryDecision:
      canonicalConnections.length > 0
        ? 'relink_only_after_proving_credential_ownership'
        : 'soft_delete_local_residue_and_keep_remote_untouched',
  };
});

const result = {
  checkedAt: new Date().toISOString(),
  readOnly: true,
  organization,
  targets: {
    accountIds: targetAccountIds,
    remoteProfileIds: targetProfileIds,
    usernames: targetUsernames,
    conflictingConnectionIds,
  },
  latestBatches,
  latestBatchFailures: latestBatchItems.filter((item) => item.status === 'failed'),
  latestBatchConflicts: latestBatchLogs.filter((item) => item.status === 'conflict'),
  latestBatchFailureLogs: latestBatchLogs.filter((item) => item.status === 'failed'),
  organizationConnections,
  targetClassification,
  globalIdentityMatches: {
    byAccount: globalProfilesByAccount,
    byRemoteProfile: globalProfilesByRemoteProfile,
    byUsername: globalProfilesByUsername,
    canonicalConnectionByRemoteProfile,
  },
  acceptedCanonicalAccounts: acceptedAccounts.map((remote) => ({
    remote,
    globalRows: unique([
      ...globalAcceptedProfilesByAccount.filter((profile) => profile.zernio_account_id === remote.accountId).map((profile) => profile.id),
      ...globalAcceptedProfilesByUsername.filter((profile) => profile.username === remote.username).map((profile) => profile.id),
    ]).map((profileId) =>
      [...globalAcceptedProfilesByAccount, ...globalAcceptedProfilesByUsername].find((profile) => profile.id === profileId),
    ),
    normalizedGlobalRows: allGlobalZernioProfiles.filter(
      (profile) => String(profile.username).replace(/^@/, '').trim().toLocaleLowerCase('en-US') === remote.username,
    ),
  })),
  repeatedCredentials,
  operationalResidues: {
    openAttempts: sections.connectionAttempts.rows.filter((row) => ['started', 'redirected', 'callback_received'].includes(row.status)),
    activeIntents: sections.connectionIntents.rows.filter((row) => ['started', 'reserved', 'redirected', 'callback_received'].includes(row.status)),
    liveTurns: sections.oauthTurns.rows.filter((row) => ['waiting', 'active'].includes(row.status)),
    activeReservations: sections.slotReservations.rows.filter((row) => !row.released_at && isFuture(row.expires_at)),
    staleReservations: sections.slotReservations.rows.filter((row) => !row.released_at && !isFuture(row.expires_at)),
    liveConnectionLocks: sections.connectionOperationLocks.rows.filter((row) => isFuture(row.locked_until)),
    liveOrganizationLocks: sections.organizationSyncLocks.rows.filter((row) => isFuture(row.locked_until)),
    liveImportLocks: sections.connectionImportLocks.rows.filter((row) => isFuture(row.locked_until)),
  },
  sections,
};

console.log(JSON.stringify(result, null, 2));
