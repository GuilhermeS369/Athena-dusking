#!/usr/bin/env node

// Consolidação explicitamente autorizada para cinco pares Pomodoro que usam a
// mesma API key. Move somente os vínculos locais para a conexão mantida e faz
// soft-delete da excedente; nunca chama a API da Zernio nem remove Instagram.
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

const apply = process.argv.includes('--apply');
const releaseFailedClaims = process.argv.includes('--release-failed-claims');
const organizationId = '58785306-4dfb-432f-8de0-f0b33f91f3de';
const pairs = [
  { retainedId: '8a8b71ca-e8b9-484d-be2a-12429b45d638', removedId: '2b0c389e-178f-47e6-aebb-4bea4425807c' },
  { retainedId: 'b668c487-43c5-42bc-83f4-c6e1a30a0ad0', removedId: 'c6f59b8a-1968-42e3-93d5-a3e932abe468' },
  { retainedId: '9421d2fb-4fb6-4254-9256-0148611f8a01', removedId: '54e7d07c-fde6-422d-b376-232a4e09491c' },
  { retainedId: '801cd150-b3de-4cd9-b03e-322525bcadc7', removedId: '76616817-fad0-433c-b25b-e0bffcc8cc29' },
  { retainedId: 'c2859445-9a48-4812-bb7c-0641fe159422', removedId: '15890c29-e0a6-4df7-a2c1-c61a393abd51' },
];

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const connectionIds = pairs.flatMap((pair) => [pair.retainedId, pair.removedId]);
const fail = (message) => { throw new Error(message); };

const { data: organization, error: organizationError } = await supabase
  .from('organizations').select('id, name').eq('id', organizationId).eq('name', 'Pomodoro').single();
if (organizationError || !organization) fail('A organização Pomodoro autorizada não foi encontrada.');

const [connectionsResult, remoteProfilesResult, localProfilesResult, pendingAttemptsResult] = await Promise.all([
  supabase.from('zernio_connections')
    .select('id, organization_id, label, zernio_profile_id, status, deleted_at')
    .in('id', connectionIds),
  supabase.from('zernio_connection_remote_profiles')
    .select('id, organization_id, zernio_connection_id, zernio_profile_id, kind, status, claimed_by_attempt_id')
    .eq('organization_id', organizationId).in('zernio_connection_id', connectionIds),
  supabase.from('instagram_profiles')
    .select('id, username, status, zernio_connection_id, zernio_profile_id, zernio_account_id, deleted_at')
    .eq('organization_id', organizationId).eq('provider', 'zernio').in('zernio_connection_id', connectionIds),
  supabase.from('zernio_connection_attempts')
    .select('id, zernio_connection_id, status, zernio_profile_id')
    .eq('organization_id', organizationId).in('zernio_connection_id', connectionIds)
    .in('status', ['started', 'redirected', 'callback_received']),
]);
const queryError = [connectionsResult, remoteProfilesResult, localProfilesResult, pendingAttemptsResult].map((result) => result.error).find(Boolean);
if (queryError) throw queryError;

const connections = connectionsResult.data ?? [];
const remoteProfiles = remoteProfilesResult.data ?? [];
const localProfiles = localProfilesResult.data ?? [];
const pendingAttempts = pendingAttemptsResult.data ?? [];
if (connections.length !== connectionIds.length) fail('Uma ou mais conexões autorizadas não foram encontradas.');
if (connections.some((connection) => connection.organization_id !== organizationId || connection.deleted_at !== null)) fail('Uma conexão autorizada não está ativa na organização Pomodoro.');
if (pendingAttempts.length) fail(`Há tentativa Zernio não terminal nas conexões autorizadas; consolidação bloqueada: ${JSON.stringify(pendingAttempts)}.`);
const claimedRemoteProfiles = remoteProfiles.filter((profile) => profile.status === 'claimed');
if (claimedRemoteProfiles.length) {
  const claimAttemptIds = claimedRemoteProfiles.map((profile) => profile.claimed_by_attempt_id).filter(Boolean);
  const { data: claimAttempts, error: claimAttemptsError } = claimAttemptIds.length
    ? await supabase.from('zernio_connection_attempts').select('id, status').in('id', claimAttemptIds)
    : { data: [], error: null };
  if (claimAttemptsError) throw claimAttemptsError;
  const releasableClaims = claimedRemoteProfiles.filter((profile) => claimAttempts?.some((attempt) => attempt.id === profile.claimed_by_attempt_id && attempt.status === 'failed'));
  if (releasableClaims.length !== claimedRemoteProfiles.length) {
    fail(`Há profile remoto Zernio em uso por tentativa não falha; consolidação bloqueada: ${JSON.stringify(claimedRemoteProfiles)}.`);
  }
  if (!releaseFailedClaims || !apply) {
    console.log(JSON.stringify({
      mode: 'blocked_pending_authorized_release',
      remoteDeleteCalled: false,
      organization,
      releasableFailedClaims: releasableClaims.map((profile) => ({ id: profile.id, zernioConnectionId: profile.zernio_connection_id, zernioProfileId: profile.zernio_profile_id, claimedByAttemptId: profile.claimed_by_attempt_id })),
    }, null, 2));
    process.exit(0);
  }
  const now = new Date().toISOString();
  const { error: releaseError } = await supabase.from('zernio_connection_remote_profiles')
    .update({ status: 'available', claimed_by_attempt_id: null, released_at: now, release_reason: 'administrative_release_after_failed_attempt', updated_at: now })
    .in('id', releasableClaims.map((profile) => profile.id)).eq('status', 'claimed');
  if (releaseError) throw releaseError;
  for (const released of releasableClaims) {
    released.status = 'available';
    released.claimed_by_attempt_id = null;
  }
}

const plan = pairs.map((pair) => {
  const retained = connections.find((connection) => connection.id === pair.retainedId);
  const removed = connections.find((connection) => connection.id === pair.removedId);
  const sourceRemoteProfiles = remoteProfiles.filter((profile) => profile.zernio_connection_id === pair.removedId);
  const sourceLocalProfiles = localProfiles.filter((profile) => profile.zernio_connection_id === pair.removedId);
  const missingRemoteProfile = sourceLocalProfiles.find((profile) => !remoteProfiles.some((remote) => remote.zernio_connection_id === pair.removedId && remote.zernio_profile_id === profile.zernio_profile_id));
  if (missingRemoteProfile) fail(`O perfil local @${missingRemoteProfile.username} não possui profile remoto correspondente na conexão a remover.`);
  return {
    retained: { id: retained.id, label: retained.label },
    removed: { id: removed.id, label: removed.label },
    remoteProfiles: sourceRemoteProfiles.map((profile) => ({ id: profile.id, zernioProfileId: profile.zernio_profile_id, status: profile.status })),
    localProfiles: sourceLocalProfiles.map((profile) => ({ id: profile.id, username: profile.username, zernioProfileId: profile.zernio_profile_id, zernioAccountId: profile.zernio_account_id, deletedAt: profile.deleted_at })),
  };
});

if (!apply) {
  console.log(JSON.stringify({ mode: 'dry_run', remoteDeleteCalled: false, organization, plan }, null, 2));
  process.exit(0);
}

const result = [];
for (const item of plan) {
  const now = new Date().toISOString();
  const remoteProfileIds = item.remoteProfiles.map((profile) => profile.id);
  const localProfileIds = item.localProfiles.map((profile) => profile.id);

  if (remoteProfileIds.length) {
    const { error } = await supabase.from('zernio_connection_remote_profiles')
      .update({ zernio_connection_id: item.retained.id, updated_at: now })
      .in('id', remoteProfileIds).eq('organization_id', organizationId).eq('zernio_connection_id', item.removed.id);
    if (error) throw error;
  }
  if (localProfileIds.length) {
    const { error } = await supabase.from('instagram_profiles')
      .update({ zernio_connection_id: item.retained.id })
      .in('id', localProfileIds).eq('organization_id', organizationId).eq('provider', 'zernio').eq('zernio_connection_id', item.removed.id);
    if (error) throw error;
  }
  const { data: deleted, error: deleteError } = await supabase.from('zernio_connections')
    .update({ deleted_at: now, status: 'offline' })
    .eq('id', item.removed.id).eq('organization_id', organizationId).is('deleted_at', null)
    .select('id, label, deleted_at').single();
  if (deleteError) throw deleteError;
  result.push({ ...item, removedConnection: deleted });
}

console.log(JSON.stringify({ mode: 'applied', remoteDeleteCalled: false, organization, result }, null, 2));
