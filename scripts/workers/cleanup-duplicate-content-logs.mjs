#!/usr/bin/env node

// Limpa apenas o histórico do falso positivo de conteúdo duplicado.
// Publicações e agendamentos são deliberadamente preservados.
// O modo padrão é dry-run; --apply grava um backup antes de excluir qualquer linha.
import fs from 'node:fs';
import path from 'node:path';
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

const APPLY = process.argv.includes('--apply');
const RESIDUAL_AFTER_PRIMARY = process.argv.includes('--residual-after-primary');
const ANOMALIES_ONLY = process.argv.includes('--anomalies-only');
const LEGACY_RESIDUAL_EVENT_IDS = [
  'd90168ac-5a17-4ce1-8027-208ad9670ca4',
  '24680133-915d-4273-aee1-afbb25370b96',
];
const PUBLICATION_MESSAGE_PATTERN = 'Duplicate content detected.%';
const ANOMALY_MESSAGE_PATTERN = '%exact content is already scheduled%';
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) throw new Error('Credenciais Supabase ausentes.');

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function fetchAll(table, columns, configure = (query) => query) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    let query = supabase.from(table).select(columns).order('id', { ascending: true }).range(from, from + 999);
    query = configure(query);
    const { data, error } = await query;
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

async function fetchByIds(table, columns, field, ids) {
  const rows = [];
  for (let index = 0; index < ids.length; index += 100) {
    const { data, error } = await supabase.from(table).select(columns).in(field, ids.slice(index, index + 100));
    if (error) throw error;
    rows.push(...data);
  }
  return rows;
}

async function deleteByIds(table, field, ids) {
  const deleted = [];
  for (let index = 0; index < ids.length; index += 100) {
    const { data, error } = await supabase.from(table).delete().in(field, ids.slice(index, index + 100)).select(field);
    if (error) throw error;
    deleted.push(...data);
  }
  return deleted;
}

const publicationEvents = ANOMALIES_ONLY
  ? []
  : RESIDUAL_AFTER_PRIMARY
  ? (await fetchByIds('publication_item_events', '*', 'id', LEGACY_RESIDUAL_EVENT_IDS))
  : [
  ...(await fetchAll('publication_item_events', '*', (query) =>
    query.eq('event_type', 'failed').ilike('error_message', PUBLICATION_MESSAGE_PATTERN),
  )),
  // Dois registros antigos receberam a mensagem bruta da Zernio e o código HTTP,
  // antes da normalização para user_content.
  ...(await fetchAll('publication_item_events', '*', (query) =>
    query.eq('event_type', 'failed').eq('error_code', '409').ilike('error_message', ANOMALY_MESSAGE_PATTERN),
  )),
  ];
const zernioAnomalies = RESIDUAL_AFTER_PRIMARY
  ? []
  : await fetchAll('zernio_publication_request_anomalies', '*', (query) =>
    query.eq('http_status', 409).ilike('error_message', ANOMALY_MESSAGE_PATTERN),
  );

// Consultar diretamente pela mensagem também alcança projeções cujo registro-fonte
// já tenha sido removido por retenção e evita filtros enormes de source_id.
const observabilityEvents = [
  ...((ANOMALIES_ONLY || RESIDUAL_AFTER_PRIMARY) ? [] : await fetchAll('instagram_observability_events', '*', (query) =>
    query.eq('source_type', 'publication_item_event').ilike('message', PUBLICATION_MESSAGE_PATTERN),
  )),
  ...(ANOMALIES_ONLY ? [] : await fetchAll('instagram_observability_events', '*', (query) =>
    query.eq('source_type', 'publication_item_event').ilike('message', ANOMALY_MESSAGE_PATTERN),
  )),
  ...(ANOMALIES_ONLY
    ? (await fetchByIds(
      'instagram_observability_events', '*', 'source_id', zernioAnomalies.map((row) => row.id),
    )).filter((row) => row.source_type === 'zernio_publication_request_anomaly')
    : await fetchAll('instagram_observability_events', '*', (query) =>
      query.eq('source_type', 'zernio_publication_request_anomaly').ilike('message', ANOMALY_MESSAGE_PATTERN),
    )),
];

const targetObservabilityIds = new Set(observabilityEvents.map((row) => row.id));
const incidentIds = [...new Set(observabilityEvents.map((row) => row.incident_id).filter(Boolean))];
const incidents = await fetchByIds('instagram_observability_incidents', '*', 'id', incidentIds);
const incidentProfiles = await fetchByIds('instagram_observability_incident_profiles', '*', 'incident_id', incidentIds);
const incidentEntities = await fetchByIds('instagram_observability_incident_entities', '*', 'incident_id', incidentIds);
const incidentActions = await fetchByIds('instagram_observability_incident_actions', '*', 'incident_id', incidentIds);
const allIncidentEvents = await fetchByIds('instagram_observability_events', '*', 'incident_id', incidentIds);
const remainingIncidentEvents = allIncidentEvents.filter((row) => !targetObservabilityIds.has(row.id));

if (incidentActions.length > 0) {
  throw new Error('A limpeza foi abortada porque um incidente afetado possui ações manuais; revisão humana necessária.');
}

const summary = {
  mode: APPLY ? 'apply' : 'dry_run',
  publicationItemEvents: publicationEvents.length,
  zernioRequestAnomalies: zernioAnomalies.length,
  observabilityEvents: observabilityEvents.length,
  affectedIncidents: incidents.length,
  organizations: [...new Set([
    ...publicationEvents.map((row) => row.organization_id),
    ...zernioAnomalies.map((row) => row.organization_id),
  ])].length,
  formats: observabilityEvents.reduce((counts, row) => {
    const format = row.publication_format ?? 'provider_request';
    counts[format] = (counts[format] ?? 0) + 1;
    return counts;
  }, {}),
};

if (!APPLY) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

if (publicationEvents.length === 0 && zernioAnomalies.length === 0 && observabilityEvents.length === 0) {
  console.log(JSON.stringify({ ...summary, result: 'already_clean' }, null, 2));
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.resolve('artifacts', `duplicate-content-log-cleanup-backup-${stamp}.json`);
fs.mkdirSync(path.dirname(backupPath), { recursive: true });
fs.writeFileSync(backupPath, JSON.stringify({
  backedUpAt: new Date().toISOString(),
  scope: {
    publicationMessagePattern: PUBLICATION_MESSAGE_PATTERN,
    anomalyMessagePattern: ANOMALY_MESSAGE_PATTERN,
  },
  publicationEvents,
  zernioAnomalies,
  observabilityEvents,
  affectedIncidentState: { incidents, profiles: incidentProfiles, entities: incidentEntities, actions: incidentActions },
}, null, 2));

const deletedObservability = await deleteByIds(
  'instagram_observability_events', 'id', observabilityEvents.map((row) => row.id),
);
if (deletedObservability.length !== observabilityEvents.length) {
  throw new Error(`Exclusão parcial em instagram_observability_events: ${deletedObservability.length}/${observabilityEvents.length}.`);
}

const deletedPublicationEvents = await deleteByIds(
  'publication_item_events', 'id', publicationEvents.map((row) => row.id),
);
if (deletedPublicationEvents.length !== publicationEvents.length) {
  throw new Error(`Exclusão parcial em publication_item_events: ${deletedPublicationEvents.length}/${publicationEvents.length}.`);
}

const deletedAnomalies = await deleteByIds(
  'zernio_publication_request_anomalies', 'id', zernioAnomalies.map((row) => row.id),
);
if (deletedAnomalies.length !== zernioAnomalies.length) {
  throw new Error(`Exclusão parcial em zernio_publication_request_anomalies: ${deletedAnomalies.length}/${zernioAnomalies.length}.`);
}

await deleteByIds('instagram_observability_incident_profiles', 'incident_id', incidentIds);
await deleteByIds('instagram_observability_incident_entities', 'incident_id', incidentIds);

const severityRank = { info: 0, warning: 1, error: 2, critical: 3 };
const stateForEntity = {
  action_required: 'active', investigating: 'active', auto_recovering: 'recovering',
  contained: 'contained', resolved: 'resolved',
};

for (const incident of incidents) {
  const events = remainingIncidentEvents
    .filter((row) => row.incident_id === incident.id)
    .sort((left, right) => left.occurred_at.localeCompare(right.occurred_at) || left.id.localeCompare(right.id));

  if (events.length === 0) {
    const { error } = await supabase.from('instagram_observability_incidents').delete().eq('id', incident.id);
    if (error) throw error;
    continue;
  }

  let treatment = events[0].treatment_state;
  let reopenCount = 0;
  let resolvedAt = treatment === 'resolved' ? events[0].occurred_at : null;
  for (const event of events.slice(1)) {
    if (treatment === 'resolved' && event.treatment_state !== 'resolved') reopenCount += 1;
    if (treatment === 'resolved' && event.treatment_state !== 'resolved') treatment = event.treatment_state;
    else if (event.treatment_state === 'action_required') treatment = 'action_required';
    else if (treatment !== 'action_required' || event.treatment_state === 'resolved') treatment = event.treatment_state;
    resolvedAt = treatment === 'resolved' ? event.occurred_at : null;
  }

  const latest = events.at(-1);
  const severity = events.reduce(
    (current, event) => severityRank[event.severity] >= severityRank[current] ? event.severity : current,
    events[0].severity,
  );
  const profileGroups = new Map();
  const entityGroups = new Map();
  for (const event of events) {
    if (event.profile_id) {
      const current = profileGroups.get(event.profile_id);
      if (!current) profileGroups.set(event.profile_id, { first: event.occurred_at, last: event.occurred_at, count: 1 });
      else { current.last = event.occurred_at > current.last ? event.occurred_at : current.last; current.count += 1; }
    }
    for (const [entityType, field] of [
      ['connection', 'connection_id'], ['group', 'source_group_id'], ['batch', 'batch_id'],
      ['item', 'item_id'], ['job', 'job_id'], ['attempt', 'attempt_id'],
    ]) {
      const entityId = event[field];
      if (!entityId) continue;
      const key = `${entityType}:${entityId}`;
      const state = stateForEntity[event.treatment_state];
      const current = entityGroups.get(key);
      if (!current) entityGroups.set(key, { entityType, entityId, state, first: event.occurred_at, last: event.occurred_at, count: 1, resolvedAt: state === 'resolved' ? event.occurred_at : null });
      else {
        current.state = state;
        current.last = event.occurred_at > current.last ? event.occurred_at : current.last;
        current.count += 1;
        current.resolvedAt = state === 'resolved' ? event.occurred_at : null;
      }
    }
  }

  const { error: incidentError } = await supabase.from('instagram_observability_incidents').update({
    severity,
    treatment_state: treatment,
    title: latest.message,
    first_seen_at: events[0].occurred_at,
    last_seen_at: latest.occurred_at,
    occurrence_count: events.length,
    affected_profile_count: profileGroups.size,
    reopen_count: reopenCount,
    latest_countermeasure: latest.countermeasure ?? {},
    investigating_at: null,
    investigating_by: null,
    resolved_at: resolvedAt,
    resolved_by: null,
    resolution_justification: null,
    fix_reference: null,
  }).eq('id', incident.id);
  if (incidentError) throw incidentError;

  const rebuiltProfiles = [...profileGroups.entries()].map(([profileId, group]) => ({
    incident_id: incident.id,
    profile_id: profileId,
    first_seen_at: group.first,
    last_seen_at: group.last,
    occurrence_count: group.count,
  }));
  if (rebuiltProfiles.length > 0) {
    const { error } = await supabase.from('instagram_observability_incident_profiles').insert(rebuiltProfiles);
    if (error) throw error;
  }

  const rebuiltEntities = [...entityGroups.values()].map((group) => ({
    incident_id: incident.id,
    entity_type: group.entityType,
    entity_id: group.entityId,
    state: group.state,
    first_seen_at: group.first,
    last_seen_at: group.last,
    resolved_at: group.resolvedAt,
    occurrence_count: group.count,
  }));
  for (let index = 0; index < rebuiltEntities.length; index += 500) {
    const { error } = await supabase.from('instagram_observability_incident_entities').insert(rebuiltEntities.slice(index, index + 500));
    if (error) throw error;
  }
}

const verificationPublicationEvents = ANOMALIES_ONLY
  ? []
  : RESIDUAL_AFTER_PRIMARY
  ? await fetchByIds('publication_item_events', 'id', 'id', LEGACY_RESIDUAL_EVENT_IDS)
  : await fetchAll('publication_item_events', 'id', (query) =>
    query.eq('event_type', 'failed').ilike('error_message', PUBLICATION_MESSAGE_PATTERN),
  );
const verificationLegacyPublicationEvents = (RESIDUAL_AFTER_PRIMARY || ANOMALIES_ONLY)
  ? []
  : await fetchAll('publication_item_events', 'id', (query) =>
    query.eq('event_type', 'failed').eq('error_code', '409').ilike('error_message', ANOMALY_MESSAGE_PATTERN),
  );
const verificationAnomalies = RESIDUAL_AFTER_PRIMARY
  ? []
  : await fetchAll('zernio_publication_request_anomalies', 'id', (query) =>
    query.eq('http_status', 409).ilike('error_message', ANOMALY_MESSAGE_PATTERN),
  );
const verificationObservability = (RESIDUAL_AFTER_PRIMARY || ANOMALIES_ONLY)
  ? await fetchByIds('instagram_observability_events', 'id', 'id', observabilityEvents.map((row) => row.id))
  : await fetchAll('instagram_observability_events', 'id', (query) =>
    query.or(`message.ilike.${PUBLICATION_MESSAGE_PATTERN},message.ilike.${ANOMALY_MESSAGE_PATTERN}`),
  );
if (verificationPublicationEvents.length || verificationLegacyPublicationEvents.length || verificationAnomalies.length || verificationObservability.length) {
  throw new Error('A verificação final ainda encontrou logs de conteúdo duplicado.');
}

console.log(JSON.stringify({
  ...summary,
  result: 'clean',
  backupPath,
  deleted: {
    publicationItemEvents: deletedPublicationEvents.length,
    zernioRequestAnomalies: deletedAnomalies.length,
    observabilityEvents: deletedObservability.length,
  },
  preserved: {
    publicationItems: true,
    publicationBatches: true,
    schedules: true,
    unrelatedIncidentEvents: remainingIncidentEvents.length,
  },
  verification: {
    publicationItemEvents: verificationPublicationEvents.length,
    legacyPublicationItemEvents: verificationLegacyPublicationEvents.length,
    zernioRequestAnomalies: verificationAnomalies.length,
    observabilityEvents: verificationObservability.length,
  },
}, null, 2));
