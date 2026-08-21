#!/usr/bin/env node

// Valida apenas a consolidação autorizada. Não altera banco ou Zernio.
import fs from 'node:fs';
import process from 'node:process';
import { createDecipheriv, createHash } from 'node:crypto';
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

const organizationId = '58785306-4dfb-432f-8de0-f0b33f91f3de';
const retainedIds = [
  '8a8b71ca-e8b9-484d-be2a-12429b45d638',
  'b668c487-43c5-42bc-83f4-c6e1a30a0ad0',
  '9421d2fb-4fb6-4254-9256-0148611f8a01',
  '801cd150-b3de-4cd9-b03e-322525bcadc7',
  'c2859445-9a48-4812-bb7c-0641fe159422',
];
const removedIds = [
  '2b0c389e-178f-47e6-aebb-4bea4425807c',
  'c6f59b8a-1968-42e3-93d5-a3e932abe468',
  '54e7d07c-fde6-422d-b376-232a4e09491c',
  '76616817-fad0-433c-b25b-e0bffcc8cc29',
  '15890c29-e0a6-4df7-a2c1-c61a393abd51',
];

function decryptToken(payload) {
  const [version, ivValue, tagValue, encryptedValue] = payload.split('.');
  const key = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY ?? '', 'base64');
  if (version !== 'v1' || key.length !== 32) throw new Error('Credencial criptografada inválida.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]).toString('utf8');
}

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const [connectionsResult, remoteProfilesResult, localProfilesResult] = await Promise.all([
  supabase.from('zernio_connections').select('id, label, encrypted_api_key, deleted_at').eq('organization_id', organizationId).in('id', [...retainedIds, ...removedIds]),
  supabase.from('zernio_connection_remote_profiles').select('zernio_connection_id, zernio_profile_id, status').eq('organization_id', organizationId).in('zernio_connection_id', retainedIds),
  supabase.from('instagram_profiles').select('id, username, zernio_connection_id, zernio_profile_id, zernio_account_id, deleted_at').eq('organization_id', organizationId).eq('provider', 'zernio').in('zernio_connection_id', retainedIds).is('deleted_at', null),
]);
const error = [connectionsResult, remoteProfilesResult, localProfilesResult].map((result) => result.error).find(Boolean);
if (error) throw error;

const connections = connectionsResult.data ?? [];
const activeConnections = connections.filter((connection) => connection.deleted_at === null);
const fingerprints = Object.values(Object.groupBy(activeConnections, (connection) => createHash('sha256').update(decryptToken(connection.encrypted_api_key)).digest('hex')));
const activeProfiles = localProfilesResult.data ?? [];
const remoteProfiles = remoteProfilesResult.data ?? [];
const allowedRemoteProfiles = new Set(remoteProfiles.map((profile) => `${profile.zernio_connection_id}:${profile.zernio_profile_id}`));
const invalidProfiles = activeProfiles.filter((profile) => !allowedRemoteProfiles.has(`${profile.zernio_connection_id}:${profile.zernio_profile_id}`));
const result = {
  checkedAt: new Date().toISOString(),
  readOnly: true,
  remoteDeleteCalled: false,
  retainedConnectionsActive: retainedIds.every((id) => activeConnections.some((connection) => connection.id === id)),
  removedConnectionsSoftDeleted: removedIds.every((id) => connections.some((connection) => connection.id === id && connection.deleted_at !== null)),
  duplicateApiKeyGroupsAmongAffectedActiveConnections: fingerprints.filter((group) => group.length > 1).map((group) => group.map(({ label }) => label)),
  activeProfilesOnRetainedConnections: activeProfiles.map(({ username, zernio_connection_id: connectionId, zernio_profile_id: profileId, zernio_account_id: accountId }) => ({ username, connectionId, profileId, accountId })),
  activeProfilesWithoutOwnedRemoteProfile: invalidProfiles.map(({ username, zernio_connection_id: connectionId, zernio_profile_id: profileId }) => ({ username, connectionId, profileId })),
};
console.log(JSON.stringify(result, null, 2));
if (!result.retainedConnectionsActive || !result.removedConnectionsSoftDeleted || result.duplicateApiKeyGroupsAmongAffectedActiveConnections.length || result.activeProfilesWithoutOwnedRemoteProfile.length) process.exitCode = 1;
