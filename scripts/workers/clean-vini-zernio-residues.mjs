#!/usr/bin/env node

// Limpeza cirúrgica do incidente Vini. O modo padrão é dry-run; --apply exige
// que o preflight continue provando exatamente os sete resíduos conhecidos.
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
const PREFLIGHT_PATH = '.zernio-vini-farmando-cash-deep-preflight-2026-08-16.json';
const APPLY = process.argv.includes('--apply');
const EXPECTED = new Map([
  ['9c793692-0ffa-453f-89dc-19f43e0ad9e6', '6a80cacc77555aae0121b41d'],
  ['94394234-7499-4351-a66c-d0d65ea7aae5', '6a80cacb77555aae0121b375'],
  ['536f9dd8-5aea-4b30-b64f-d85f73e46d92', '6a80d7a777555aae01249745'],
  ['6f734bcc-0a75-416e-af07-0f42e748f250', '6a80c25177555aae011f0f06'],
  ['f20d0a9e-3aad-489a-9d56-365cb52e03c1', '6a80d7a877555aae01249766'],
  ['5f663039-0106-4315-b360-711f44c9fad0', '6a80d7a777555aae0124974f'],
  ['e1ad0dbc-c571-45fc-8df0-6d5c77f8dae4', '6a80d7a877555aae01249756'],
]);

if (!fs.existsSync(PREFLIGHT_PATH)) throw new Error(`Preflight ausente: ${PREFLIGHT_PATH}`);
const preflight = JSON.parse(fs.readFileSync(PREFLIGHT_PATH, 'utf8'));
if (preflight.organization?.id !== ORGANIZATION_ID || preflight.readOnly !== true) {
  throw new Error('Preflight não corresponde à organização Vini ou não é read-only.');
}

const candidates = preflight.targetClassification.flatMap((classification) =>
  classification.localRows
    .filter((profile) => !profile.deleted_at && EXPECTED.has(profile.id))
    .map((profile) => ({ profile, remote: classification.remote, publicationSummary: classification.publicationSummary })),
);

if (candidates.length !== EXPECTED.size) throw new Error(`Esperados 7 resíduos ativos; encontrados ${candidates.length}.`);
for (const candidate of candidates) {
  const expectedAccountId = EXPECTED.get(candidate.profile.id);
  if (candidate.profile.organization_id !== ORGANIZATION_ID || candidate.profile.zernio_account_id !== expectedAccountId) {
    throw new Error(`Identidade inesperada no perfil ${candidate.profile.id}.`);
  }
  if (candidate.profile.zernio_profile_id !== candidate.remote.profileId) throw new Error(`Profile remoto divergente no perfil ${candidate.profile.id}.`);
  if (candidate.profile.zernio_connection_id !== candidate.remote.observedOnConnectionId) throw new Error(`Conexão observada divergente no perfil ${candidate.profile.id}.`);
  if ((candidate.publicationSummary?.nonTerminal ?? 0) !== 0) throw new Error(`Perfil ${candidate.profile.id} possui publicação não terminal.`);
  const canonical = preflight.organizationConnections.find((connection) => connection.id === candidate.profile.zernio_connection_id);
  if (!canonical || canonical.zernio_profile_id === candidate.profile.zernio_profile_id) {
    throw new Error(`Perfil ${candidate.profile.id} deixou de ser resíduo canônico; aborte a limpeza.`);
  }
  const externalCanonical = preflight.globalIdentityMatches.canonicalConnectionByRemoteProfile
    .find((row) => row.remoteProfileId === candidate.profile.zernio_profile_id)?.matchingConnections ?? [];
  if (externalCanonical.length !== 0) throw new Error(`Perfil ${candidate.profile.id} ganhou conexão canônica; aborte a limpeza.`);
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) throw new Error('Credenciais Supabase ausentes.');
const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
const now = new Date().toISOString();
const profileIds = candidates.map((candidate) => candidate.profile.id);
const result = { mode: APPLY ? 'apply' : 'dry_run', checkedAt: now, organizationId: ORGANIZATION_ID, profileIds, steps: [] };

if (!APPLY) {
  result.steps.push({ action: 'soft_delete_seven_cross_profile_residues', count: profileIds.length });
  result.steps.push({ action: 'fail_stale_redirected_attempt', attemptId: '0a2bd8a1-e764-4d01-be74-9e6b798c9854' });
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const { data: deletedProfiles, error: deleteError } = await supabase
  .from('instagram_profiles')
  .update({ deleted_at: now, status: 'offline' })
  .eq('organization_id', ORGANIZATION_ID)
  .in('id', profileIds)
  .is('deleted_at', null)
  .select('id, username, zernio_account_id, zernio_connection_id, zernio_profile_id, deleted_at');
if (deleteError) throw deleteError;
if ((deletedProfiles ?? []).length !== profileIds.length) throw new Error(`Soft delete parcial: ${(deletedProfiles ?? []).length}/7.`);
result.steps.push({ action: 'soft_deleted_profiles', rows: deletedProfiles });

const staleAttemptId = '0a2bd8a1-e764-4d01-be74-9e6b798c9854';
const { data: failedAttempt, error: attemptError } = await supabase
  .from('zernio_connection_attempts')
  .update({
    status: 'failed', failed_at: now, worker_status: 'failed', worker_completed_at: now,
    worker_error_code: 'historical_redirect_abandoned', worker_error_stage: 'cleanup',
    last_error_message: 'Tentativa histórica encerrada durante limpeza: OAuth redirecionado sem callback.',
  })
  .eq('id', staleAttemptId)
  .eq('organization_id', ORGANIZATION_ID)
  .in('status', ['started', 'redirected', 'callback_received'])
  .select('id, status, failed_at, worker_status');
if (attemptError) throw attemptError;
result.steps.push({ action: 'failed_stale_attempt', rows: failedAttempt ?? [] });

const { data: releasedReservations, error: reservationError } = await supabase
  .from('zernio_connection_slot_reservations')
  .update({ released_at: now, release_reason: 'vini_residue_cleanup' })
  .eq('organization_id', ORGANIZATION_ID)
  .is('released_at', null)
  .lte('expires_at', now)
  .select('id, zernio_connection_id');
if (reservationError) throw reservationError;
result.steps.push({ action: 'released_expired_reservations', rows: releasedReservations ?? [] });

console.log(JSON.stringify(result, null, 2));
