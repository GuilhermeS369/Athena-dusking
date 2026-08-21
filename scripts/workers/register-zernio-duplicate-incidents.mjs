#!/usr/bin/env node

// Registra incidentes duráveis a partir de um snapshot canônico já revalidado.
// Não chama DELETE remoto e exige congelamento destrutivo ativo.
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

function normalizeUsername(value) {
  return String(value ?? '').replace(/^@/, '').trim().toLocaleLowerCase('en-US');
}

const snapshotPath = argument('--snapshot');
const requestedUsernames = new Set((argument('--usernames') ?? '').split(',').map(normalizeUsername).filter(Boolean));
const apply = process.argv.includes('--apply');
if (!snapshotPath) throw new Error('Informe --snapshot=<arquivo.json>.');
if (!fs.existsSync(snapshotPath)) throw new Error(`Snapshot não encontrado: ${snapshotPath}`);
if (!requestedUsernames.size) throw new Error('Informe --usernames=<username1,username2>.');

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) throw new Error('Credenciais do Supabase não encontradas.');
const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));

const remoteRows = snapshot.connections.flatMap((connection) => connection.remoteAccounts.map((account) => ({
  organizationId: connection.organizationId,
  connectionId: connection.id,
  connectionLabel: connection.label,
  accountId: account.accountId,
  username: normalizeUsername(account.username),
})));
const localProfiles = snapshot.connections
  .flatMap((connection) => connection.localProfiles)
  .filter((profile, index, profiles) => profiles.findIndex((candidate) => candidate.id === profile.id) === index);

const decisions = [];
for (const username of requestedUsernames) {
  const occurrences = remoteRows.filter((row) => row.username === username);
  const retained = localProfiles.find((profile) => normalizeUsername(profile.username) === username && !profile.deleted_at);
  if (!retained) throw new Error(`Perfil canônico local não encontrado para @${username}.`);
  const retainedOccurrence = occurrences.find((row) => row.connectionId === retained.zernio_connection_id && row.accountId === retained.zernio_account_id);
  if (!retainedOccurrence) throw new Error(`Vínculo canônico exato não está presente no snapshot para @${username}.`);
  const excess = occurrences.filter((row) => row.connectionId !== retainedOccurrence.connectionId || row.accountId !== retainedOccurrence.accountId);
  if (excess.length !== 1) throw new Error(`Esperada uma ocorrência excedente para @${username}; encontradas ${excess.length}.`);
  decisions.push({ username, retainedProfileId: retained.id, retained: retainedOccurrence, removed: excess[0] });
}

const organizationIds = [...new Set(decisions.map((decision) => decision.retained.organizationId))];
const { data: controls, error: controlsError } = await supabase
  .from('zernio_sync_operational_controls')
  .select('organization_id, automatic_duplicate_removal_enabled')
  .in('organization_id', organizationIds);
if (controlsError) throw controlsError;
for (const organizationId of organizationIds) {
  const control = controls?.find((row) => row.organization_id === organizationId);
  if (!control || control.automatic_duplicate_removal_enabled !== false) {
    throw new Error(`Congelamento destrutivo não confirmado para a organização ${organizationId}; operação abortada.`);
  }
}

if (apply) {
  for (const decision of decisions) {
    const { error } = await supabase.rpc('schedule_zernio_duplicate_identity_disconnection', {
      p_organization_id: decision.retained.organizationId,
      p_zernio_connection_id: decision.removed.connectionId,
      p_zernio_account_id: decision.removed.accountId,
      p_username: decision.username,
      p_retained_profile_id: decision.retainedProfileId,
    });
    if (error) throw error;
  }
}

const { data: incidents, error: incidentsError } = await supabase
  .from('zernio_profile_disconnection_incidents')
  .select('id, organization_id, normalized_identity, state, defer_reason, profile_id, retained_profile_id, retained_connection_label_snapshot, retained_zernio_account_id, removed_connection_label_snapshot, removed_zernio_account_id, occurrence_count')
  .in('normalized_identity', [...requestedUsernames]);
if (incidentsError) throw incidentsError;

const incidentIds = (incidents ?? []).map((incident) => incident.id);
const jobsResult = incidentIds.length
  ? await supabase.from('zernio_profile_recycling_jobs').select('incident_id, status, attempt_count, max_attempts, deferred_reason').in('incident_id', incidentIds)
  : { data: [], error: null };
if (jobsResult.error) throw jobsResult.error;

console.log(JSON.stringify({
  mode: apply ? 'applied' : 'dry_run',
  snapshot: snapshotPath,
  snapshotCheckedAt: snapshot.checkedAt,
  destructiveRemovalFrozen: true,
  remoteDeleteCalled: false,
  decisions,
  incidents: incidents ?? [],
  jobs: jobsResult.data ?? [],
}, null, 2));
