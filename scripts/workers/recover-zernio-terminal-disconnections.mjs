#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

for (const filePath of ['.env.local', '.env.worker', '.env.worker.deploy']) loadEnvFile(filePath);

const mode = valueArg('--mode') ?? (process.argv.includes('--apply') ? 'apply' : 'dry-run');
const since = valueArg('--since') ?? '2026-08-26T18:00:00Z';
const limit = boundedInteger(valueArg('--limit'), 10, 1, 100);
const maxRounds = boundedInteger(valueArg('--max-rounds'), 100, 1, 1000);
if (!['dry-run', 'backup', 'apply', 'drain', 'report'].includes(mode)) {
  throw new Error('Modo inválido. Use dry-run, backup, apply, drain ou report.');
}
if (Number.isNaN(Date.parse(since))) throw new Error('Data --since inválida.');

const supabase = createClient(requiredEnv('NEXT_PUBLIC_SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { autoRefreshToken: false, persistSession: false },
});

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
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

function valueArg(name) {
  const prefix = `${name}=`;
  return process.argv.find((entry) => entry.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

// A ordenacao e aplicada AQUI, depois do configure, e por isso e parametro
// obrigatorio na pratica: paginar por range sem ordem TOTAL faz paginas
// consecutivas repetirem linhas e perderem outras, sem erro nenhum. Um perfil
// com mais de 1.000 itens fazia esta recuperacao agir sobre o conjunto errado.
// Medido em producao em 30/08/2026 noutra tabela: 7.151 linhas lidas, 6.942
// distintas. orderBy precisa ser a chave da tabela, nao so um criterio bonito.
async function fetchAll(table, columns, configure = (query) => query, orderBy = ['id']) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    let query = configure(supabase.from(table).select(columns));
    for (const column of orderBy) query = query.order(column, { ascending: true });
    const { data, error } = await query.range(from, from + 999);
    if (error) throw error;
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) return rows;
  }
}

async function loadEvidence() {
  const legacyAnomalies = await fetchAll(
    'zernio_publication_request_anomalies',
    'id,occurred_at,organization_id,zernio_connection_id,publication_item_id,batch_id,operation,outcome,http_status,provider_code,provider_request_id,error_message,attempt_count',
    (query) => query.gte('occurred_at', since).in('provider_code', ['account_disconnected', 'auth_expired']).order('occurred_at'),
  );
  const observedAnomalies = await fetchAll(
    'instagram_observability_events',
    'occurred_at,organization_id,connection_id,item_id,batch_id,http_status,provider_code,request_id,message,source_id,countermeasure,evidence',
    (query) => query.gte('occurred_at', since).eq('source_type', 'zernio_publication_request_anomaly').in('provider_code', ['account_disconnected', 'auth_expired']).order('occurred_at'),
  );
  const anomalyMap = new Map();
  for (const anomaly of legacyAnomalies) anomalyMap.set(anomaly.id, anomaly);
  for (const event of observedAnomalies) {
    if (anomalyMap.has(event.source_id)) continue;
    anomalyMap.set(event.source_id, {
      id: event.source_id,
      occurred_at: event.occurred_at,
      organization_id: event.organization_id,
      zernio_connection_id: event.connection_id,
      publication_item_id: event.item_id,
      batch_id: event.batch_id,
      operation: event.evidence?.operation ?? 'create_post',
      outcome: 'http_error',
      http_status: event.http_status,
      provider_code: event.provider_code,
      provider_request_id: event.request_id,
      error_message: event.message,
      attempt_count: event.countermeasure?.attemptCount ?? null,
      evidence_source: 'instagram_observability_events',
    });
  }
  const anomalies = [...anomalyMap.values()].sort((left, right) => Date.parse(left.occurred_at) - Date.parse(right.occurred_at));
  const itemIds = [...new Set(anomalies.map((row) => row.publication_item_id).filter(Boolean))];
  const items = itemIds.length ? await fetchAll(
    'publication_items',
    'id,organization_id,profile_id,batch_id,format,status,execute_at,attempt_count,next_attempt_at,last_error_code,last_error_message,creation_id,claimed_by,lease_until,published_at,updated_at',
    (query) => query.in('id', itemIds),
  ) : [];
  const itemMap = new Map(items.map((row) => [row.id, row]));
  const profileIds = [...new Set(items.map((row) => row.profile_id).filter(Boolean))];
  const profiles = profileIds.length ? await fetchAll(
    'instagram_profiles',
    'id,organization_id,provider,username,status,zernio_account_id,zernio_connection_id,last_error_code,last_error_message,deleted_at,updated_at',
    (query) => query.in('id', profileIds),
  ) : [];
  const profileMap = new Map(profiles.map((row) => [row.id, row]));
  const candidateMap = new Map();
  for (const anomaly of anomalies) {
    const item = itemMap.get(anomaly.publication_item_id);
    const profile = item ? profileMap.get(item.profile_id) : null;
    if (!profile || profile.provider !== 'zernio') continue;
    const candidate = candidateMap.get(profile.id) ?? {
      organizationId: profile.organization_id,
      profileId: profile.id,
      username: profile.username,
      zernioAccountId: profile.zernio_account_id,
      zernioConnectionId: profile.zernio_connection_id,
      status: profile.status,
      deletedAt: profile.deleted_at,
      signals: [],
    };
    candidate.signals.push({
      anomalyId: anomaly.id,
      occurredAt: anomaly.occurred_at,
      providerCode: anomaly.provider_code,
      httpStatus: anomaly.http_status,
      itemId: anomaly.publication_item_id,
      requestId: anomaly.provider_request_id,
      errorMessage: anomaly.error_message,
    });
    candidateMap.set(profile.id, candidate);
  }
  return { anomalies, legacyAnomalies, observedAnomalies, sourceItems: items, profiles, candidates: [...candidateMap.values()] };
}

async function loadImpact(candidates) {
  const profileIds = candidates.map((row) => row.profileId);
  if (!profileIds.length) return { queueItems: [], groupMemberships: [], planProfiles: [], horizons: [], incidents: [], jobs: [] };
  const [queueItems, groupMemberships, planProfiles, horizons, incidents] = await Promise.all([
    fetchAll('publication_items', 'id,organization_id,profile_id,batch_id,status,execute_at,attempt_count,next_attempt_at,last_error_code,last_error_message,creation_id,claimed_by,lease_until,published_at,updated_at', (query) => query.in('profile_id', profileIds)),
    // profile_group_members nao tem coluna id: a chave e (group_id, profile_id).
    fetchAll('profile_group_members', 'organization_id,profile_id,group_id,created_at', (query) => query.in('profile_id', profileIds), ['group_id', 'profile_id']),
    fetchAll('bulk_publication_plan_profiles', 'id,organization_id,profile_id,status,suspended_at,suspension_reason', (query) => query.in('profile_id', profileIds)),
    fetchAll('bulk_publication_profile_horizons', 'id,organization_id,profile_id,status,released_at', (query) => query.in('profile_id', profileIds)),
    fetchAll('zernio_profile_disconnection_incidents', '*', (query) => query.in('profile_id', profileIds)),
  ]);
  const incidentIds = incidents.map((row) => row.id);
  const jobs = incidentIds.length ? await fetchAll('zernio_profile_recycling_jobs', '*', (query) => query.in('incident_id', incidentIds)) : [];
  return { queueItems, groupMemberships, planProfiles, horizons, incidents, jobs };
}

function summarize(evidence, impact) {
  const byOrganization = new Map();
  for (const candidate of evidence.candidates) {
    const summary = byOrganization.get(candidate.organizationId) ?? { organizationId: candidate.organizationId, profiles: 0, signals: 0, queueItems: 0 };
    summary.profiles += 1;
    summary.signals += candidate.signals.length;
    summary.queueItems += impact.queueItems.filter((row) => row.profile_id === candidate.profileId && ['waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended'].includes(row.status)).length;
    byOrganization.set(candidate.organizationId, summary);
  }
  return {
    since,
    profilesWithEvidence: evidence.candidates.length,
    activeProfiles: evidence.candidates.filter((row) => !row.deletedAt).length,
    terminalSignals: evidence.anomalies.length,
    affectedQueueItems: impact.queueItems.filter((row) => ['waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended'].includes(row.status)).length,
    groupMemberships: impact.groupMemberships.length,
    byOrganization: [...byOrganization.values()],
  };
}

function writeBackup(payload) {
  const directory = path.resolve('artifacts');
  fs.mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(directory, `zernio-terminal-disconnection-recovery-backup-${stamp}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return filePath;
}

async function collectSnapshot() {
  const evidence = await loadEvidence();
  const impact = await loadImpact(evidence.candidates);
  return { collectedAt: new Date().toISOString(), summary: summarize(evidence, impact), evidence, impact };
}

function compactSnapshot(snapshot) {
  return {
    summary: snapshot.summary,
    candidates: snapshot.evidence.candidates.map((candidate) => ({
      organizationId: candidate.organizationId,
      profileId: candidate.profileId,
      username: candidate.username,
      status: candidate.status,
      deletedAt: candidate.deletedAt,
      signalCount: candidate.signals.length,
      firstSignalAt: candidate.signals[0]?.occurredAt ?? null,
      lastSignalAt: candidate.signals.at(-1)?.occurredAt ?? null,
      queueItems: snapshot.impact.queueItems.filter((row) => row.profile_id === candidate.profileId && ['waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended'].includes(row.status)).length,
    })),
  };
}

async function dryRun() {
  const snapshot = await collectSnapshot();
  return { mode: 'dry-run', ...compactSnapshot(snapshot) };
}

async function backupRecovery() {
  const snapshot = await collectSnapshot();
  const backupPath = writeBackup({ mode: 'backup', ...snapshot });
  return { mode: 'backup', backupPath, ...compactSnapshot(snapshot) };
}

async function applyRecovery() {
  const snapshot = await collectSnapshot();
  const backupPath = writeBackup({ mode: 'pre-apply-backup', ...snapshot });
  const { data: rebuilt, error: rebuildError } = await supabase.rpc('rebuild_zernio_request_observability');
  if (rebuildError) throw rebuildError;
  const scheduled = [];
  for (const candidate of snapshot.evidence.candidates.filter((row) => !row.deletedAt)) {
    const signal = candidate.signals.find((row) => row.providerCode === 'auth_expired') ?? candidate.signals.at(-1);
    const { data, error } = await supabase.rpc('schedule_zernio_sync_profile_disconnection', {
      p_organization_id: candidate.organizationId,
      p_profile_id: candidate.profileId,
      p_signal: signal.providerCode,
      p_error_code: signal.providerCode,
      p_error_message: signal.errorMessage ?? `Conta Zernio retornou ${signal.providerCode}.`,
      p_actor_label: 'system: confirmed-zernio-terminal-recovery',
    });
    if (error) {
      throw new Error(`Falha ao conter ${candidate.profileId} (${candidate.username ?? 'sem username'}): ${error.message}`);
    }
    scheduled.push({ profileId: candidate.profileId, username: candidate.username, signal: signal.providerCode, result: data });
  }
  return { mode: 'apply', backupPath, rebuilt, scheduled, before: snapshot.summary };
}

async function drainRecovery() {
  const snapshot = await collectSnapshot();
  const cohortJobIds = new Set(snapshot.impact.jobs.map((row) => row.id));
  const claimableJobs = await fetchAll(
    'zernio_profile_recycling_jobs',
    'id,incident_id,status,next_attempt_at',
    (query) => query.in('status', ['pending', 'deferred', 'remote_removal_pending', 'retry_pending', 'processing']),
  );
  const foreignJobs = claimableJobs.filter((row) => !cohortJobIds.has(row.id));
  const foreignIncidentIds = foreignJobs.map((row) => row.incident_id);
  const foreignIncidents = foreignIncidentIds.length ? await fetchAll(
    'zernio_profile_disconnection_incidents',
    'id,profile_id,signal,state',
    (query) => query.in('id', foreignIncidentIds),
  ) : [];
  const foreignIncidentMap = new Map(foreignIncidents.map((row) => [row.id, row]));
  const unsafeForeignJobs = foreignJobs.filter((job) => {
    const incident = foreignIncidentMap.get(job.incident_id);
    return job.status !== 'deferred' || incident?.signal !== 'duplicate_identity_auto_removed' || incident?.profile_id;
  });
  if (unsafeForeignJobs.length) {
    throw new Error(`Drenagem abortada: ${unsafeForeignJobs.length} job(s) externo(s) não são duplicidades antigas congeladas.`);
  }
  const { processZernioProfileRecyclingJobs } = await import('./publication-direct-dispatch.mjs');
  const workerId = `terminal-recovery-${process.pid}`;
  const rounds = [];
  for (let round = 1; round <= maxRounds; round += 1) {
    const processed = await processZernioProfileRecyclingJobs(workerId, limit);
    rounds.push({ round, processed });
    if (!processed.length) break;
  }
  return {
    mode: 'drain', workerId, cohortJobs: cohortJobIds.size,
    frozenForeignDuplicateJobs: foreignJobs.length,
    rounds, exhausted: rounds.at(-1)?.processed.length === 0,
  };
}

async function reportRecovery() {
  const snapshot = await collectSnapshot();
  return { mode: 'report', ...compactSnapshot(snapshot), incidents: snapshot.impact.incidents, jobs: snapshot.impact.jobs };
}

const result = mode === 'apply'
  ? await applyRecovery()
  : mode === 'backup'
    ? await backupRecovery()
  : mode === 'drain'
    ? await drainRecovery()
    : mode === 'report'
      ? await reportRecovery()
      : await dryRun();
console.log(JSON.stringify(result, null, 2));
