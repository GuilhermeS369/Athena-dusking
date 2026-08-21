#!/usr/bin/env node

// Finaliza no banco uma remoção global já confirmada na Zernio. Revalida a
// ausência nas duas chaves, atualiza seus inventários e aplica o soft delete
// local pela RPC transacional usada pelo endpoint administrativo.
import fs from 'node:fs';
import process from 'node:process';
import { createDecipheriv, randomUUID } from 'node:crypto';
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
const incidentId = argument('--incident-id');
if (!incidentId || !process.argv.includes('--apply')) throw new Error('Informe --incident-id e --apply.');

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
    headers: { Authorization: `Bearer ${apiKey}` }, cache: 'no-store', signal: AbortSignal.timeout(25_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`GET /v1/accounts retornou HTTP ${response.status}.`);
  return (Array.isArray(payload.accounts) ? payload.accounts : []).filter((account) => account?.platform === 'instagram');
}

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: incident, error: incidentError } = await supabase.from('zernio_profile_disconnection_incidents')
  .select('id, organization_id, state, retained_zernio_connection_id, retained_zernio_account_id, removed_zernio_connection_id, removed_zernio_account_id')
  .eq('id', incidentId).single();
if (incidentError) throw incidentError;
if (incident.retained_zernio_account_id !== incident.removed_zernio_account_id) throw new Error('O incidente não representa account ID global compartilhado.');

const connectionIds = [incident.retained_zernio_connection_id, incident.removed_zernio_connection_id];
const { data: connections, error: connectionError } = await supabase.from('zernio_connections')
  .select('id, encrypted_api_key').in('id', connectionIds).is('deleted_at', null);
if (connectionError) throw connectionError;
if (connections.length !== 2) throw new Error('As duas conexões do incidente não estão ativas.');
const accountLists = await Promise.all(connectionIds.map(async (id) => {
  const connection = connections.find((candidate) => candidate.id === id);
  return listAccounts(decryptToken(connection.encrypted_api_key));
}));
if (accountLists.some((accounts) => accounts.some((account) => [account.accountId, account._id, account.id].includes(incident.retained_zernio_account_id)))) {
  throw new Error('O account ID ainda está presente remotamente; reconciliação abortada.');
}

const workerId = `reconcile-global-removal:${randomUUID()}`;
const { data: approval, error: approvalError } = await supabase.rpc('approve_zernio_duplicate_removal_preflight', {
  p_incident_id: incident.id,
  p_snapshot_at: new Date().toISOString(),
  p_retained_connection_id: incident.retained_zernio_connection_id,
  p_retained_account_id: incident.retained_zernio_account_id,
  p_removed_connection_id: incident.removed_zernio_connection_id,
  p_removed_account_id: incident.removed_zernio_account_id,
  p_approved_by: workerId,
});
if (approvalError) throw approvalError;
const snapshotAt = new Date().toISOString();
const { error: inventoryError } = await supabase.rpc('record_zernio_shared_global_removal_inventory', {
  p_incident_id: incident.id,
  p_job_id: approval.jobId,
  p_worker_id: approval.workerId,
  p_snapshot_at: snapshotAt,
  p_retained_instagram_count: accountLists[0].length,
  p_removed_instagram_count: accountLists[1].length,
});
if (inventoryError) throw inventoryError;
const { data: completion, error: completionError } = await supabase.rpc('complete_zernio_shared_account_global_removal', {
  p_incident_id: incident.id,
  p_job_id: approval.jobId,
  p_worker_id: approval.workerId,
  p_remote_outcome: 'remote_deleted',
  p_http_status: 200,
  p_request_id: `reconciled-after-global-delete:${incident.id}`,
  p_requested_by: null,
});
if (completionError) throw completionError;
console.log(JSON.stringify({ incidentId, remoteAbsent: true, inventoryCounts: accountLists.map((accounts) => accounts.length), completion }, null, 2));
