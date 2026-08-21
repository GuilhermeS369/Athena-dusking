#!/usr/bin/env node

// Operação destrutiva controlada: exige snapshot integral recente, incidente
// estruturado, vínculo canônico exato e aprovação RPC antes de cada DELETE.
import { createDecipheriv } from 'node:crypto';
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
const snapshotPath = argument('--snapshot');
const approvedBy = argument('--approved-by') ?? 'athena-controlled-removal-2026-08-16';
const requestedUsernames = new Set((argument('--usernames') ?? '').split(',').map(normalizeUsername).filter(Boolean));
const apply = process.argv.includes('--apply');
if (!snapshotPath || !fs.existsSync(snapshotPath)) throw new Error('Informe um --snapshot existente.');
if (!requestedUsernames.size) throw new Error('Informe --usernames.');
if (!apply) throw new Error('Operação destrutiva bloqueada sem --apply explícito.');

function decryptToken(payload) {
  const [version, ivValue, tagValue, encryptedValue] = payload.split('.');
  if (version !== 'v1' || !ivValue || !tagValue || !encryptedValue) throw new Error('Chave Zernio criptografada inválida.');
  const key = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY ?? '', 'base64');
  if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY inválida ou ausente.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]).toString('utf8');
}

async function listAccounts(apiKey) {
  const response = await fetch(`${(process.env.ZERNIO_API_BASE_URL ?? 'https://zernio.com/api').replace(/\/$/, '')}/v1/accounts`, {
    headers: { Authorization: `Bearer ${apiKey}` }, cache: 'no-store', signal: AbortSignal.timeout(25_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`GET accounts retornou HTTP ${response.status}.`);
  return (Array.isArray(payload.accounts) ? payload.accounts : []).filter((account) => account?.platform === 'instagram');
}

async function disconnectAccount(apiKey, accountId, requestId) {
  const response = await fetch(`${(process.env.ZERNIO_API_BASE_URL ?? 'https://zernio.com/api').replace(/\/$/, '')}/v1/accounts/${encodeURIComponent(accountId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${apiKey}`, 'x-request-id': requestId },
    cache: 'no-store',
    signal: AbortSignal.timeout(25_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok && response.status !== 404) throw new Error(`DELETE retornou HTTP ${response.status}: ${String(payload.message ?? payload.error ?? 'sem detalhe')}`);
  return { status: response.status, requestId: response.headers.get('x-request-id') ?? requestId };
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) throw new Error('Credenciais do Supabase não encontradas.');
const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
const snapshotAt = new Date(snapshot.checkedAt);
if (Number.isNaN(snapshotAt.valueOf()) || Date.now() - snapshotAt.valueOf() > 10 * 60_000) throw new Error('Snapshot preflight ausente ou com mais de dez minutos.');
if (snapshot.connections.some((connection) => connection.error)) throw new Error('Snapshot preflight contém erro de conexão.');

const { data: incidents, error: incidentsError } = await supabase
  .from('zernio_profile_disconnection_incidents')
  .select('id, organization_id, normalized_identity, state, retained_profile_id, retained_zernio_connection_id, retained_zernio_account_id, removed_zernio_connection_id, removed_zernio_account_id')
  .in('normalized_identity', [...requestedUsernames]);
if (incidentsError) throw incidentsError;
if ((incidents ?? []).length !== requestedUsernames.size) throw new Error('Nem todas as identidades possuem incidente estruturado único.');

const connectionIds = [...new Set(incidents.flatMap((incident) => [incident.retained_zernio_connection_id, incident.removed_zernio_connection_id]))];
const { data: connections, error: connectionsError } = await supabase
  .from('zernio_connections')
  .select('id, organization_id, encrypted_api_key')
  .in('id', connectionIds)
  .is('deleted_at', null);
if (connectionsError) throw connectionsError;

const results = [];
for (const incident of incidents) {
  const retainedConnection = connections.find((connection) => connection.id === incident.retained_zernio_connection_id);
  const removedConnection = connections.find((connection) => connection.id === incident.removed_zernio_connection_id);
  if (!retainedConnection || !removedConnection) throw new Error(`Conexão canônica/excedente ausente para ${incident.normalized_identity}.`);
  if (retainedConnection.organization_id !== incident.organization_id || removedConnection.organization_id !== incident.organization_id) throw new Error('Incidente cruza organizações inesperadamente.');

  const retainedApiKey = decryptToken(retainedConnection.encrypted_api_key);
  const removedApiKey = decryptToken(removedConnection.encrypted_api_key);
  const [retainedBefore, removedBefore] = await Promise.all([listAccounts(retainedApiKey), listAccounts(removedApiKey)]);
  const sameRemoteAccount = incident.retained_zernio_account_id === incident.removed_zernio_account_id;
  if (sameRemoteAccount) throw new Error(`Remoção por accountId é global e não pode separar duas chaves com o mesmo accountId para @${incident.normalized_identity}.`);
  const canonicalExists = retainedBefore.some((account) => remoteId(account) === incident.retained_zernio_account_id && normalizeUsername(account.username) === incident.normalized_identity);
  const excessExists = removedBefore.some((account) => remoteId(account) === incident.removed_zernio_account_id && normalizeUsername(account.username) === incident.normalized_identity);
  if (!canonicalExists) throw new Error(`A ocorrência canônica não foi confirmada para @${incident.normalized_identity}.`);

  const { data: approval, error: approveError } = await supabase.rpc('approve_zernio_duplicate_removal_preflight', {
    p_incident_id: incident.id,
    p_snapshot_at: snapshot.checkedAt,
    p_retained_connection_id: incident.retained_zernio_connection_id,
    p_retained_account_id: incident.retained_zernio_account_id,
    p_removed_connection_id: incident.removed_zernio_connection_id,
    p_removed_account_id: incident.removed_zernio_account_id,
    p_approved_by: approvedBy,
  });
  if (approveError) throw approveError;

  const requestId = `athena-duplicate-${incident.id}`;
  const remoteResult = excessExists
    ? await disconnectAccount(removedApiKey, incident.removed_zernio_account_id, requestId)
    : { status: 404, requestId };
  const [retainedAfter, removedAfter] = await Promise.all([listAccounts(retainedApiKey), listAccounts(removedApiKey)]);
  const canonicalConfirmed = retainedAfter.some((account) => remoteId(account) === incident.retained_zernio_account_id && normalizeUsername(account.username) === incident.normalized_identity);
  const excessConfirmedAbsent = !removedAfter.some((account) => remoteId(account) === incident.removed_zernio_account_id);
  if (!canonicalConfirmed || !excessConfirmedAbsent) throw new Error(`Confirmação pós-DELETE falhou para @${incident.normalized_identity}.`);

  const outcome = remoteResult.status === 404 ? 'already_disconnected_404' : 'remote_deleted';
  const { data: completion, error: completionError } = await supabase.rpc('complete_zernio_profile_recycling', {
    p_job_id: approval.jobId,
    p_worker_id: approval.workerId,
    p_remote_outcome: outcome,
    p_http_status: remoteResult.status,
    p_request_id: remoteResult.requestId,
    p_error_code: null,
    p_error_message: null,
  });
  if (completionError) throw completionError;
  results.push({ identity: incident.normalized_identity, outcome, httpStatus: remoteResult.status, canonicalConfirmed, excessConfirmedAbsent, completion });
}

console.log(JSON.stringify({ snapshot: snapshotPath, snapshotAt: snapshot.checkedAt, results }, null, 2));
