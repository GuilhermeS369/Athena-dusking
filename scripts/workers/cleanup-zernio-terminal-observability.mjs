#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

for (const filePath of ['.env.local', '.env.worker', '.env.worker.deploy']) loadEnvFile(filePath);

const apply = process.argv.includes('--apply');
const through = valueArg('--through') ?? new Date().toISOString();
const incidentSince = valueArg('--incident-since') ?? '2026-08-27T13:02:00Z';
if (Number.isNaN(Date.parse(through)) || Number.isNaN(Date.parse(incidentSince))) throw new Error('Marco temporal inválido.');

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

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

async function fetchAll(table, columns, configure = (query) => query) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await configure(supabase.from(table).select(columns)).range(from, from + 999);
    if (error) throw error;
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) return rows;
  }
}

async function fetchByIds(table, columns, column, ids) {
  const rows = [];
  for (let index = 0; index < ids.length; index += 100) {
    rows.push(...await fetchAll(table, columns, (query) => query.in(column, ids.slice(index, index + 100))));
  }
  return rows;
}

async function deleteByIds(table, column, ids) {
  let deleted = 0;
  for (let index = 0; index < ids.length; index += 100) {
    const { data, error } = await supabase.from(table).delete().in(column, ids.slice(index, index + 100)).select(column);
    if (error) throw error;
    deleted += data?.length ?? 0;
  }
  return deleted;
}

const removalIncidents = await fetchAll(
  'zernio_profile_disconnection_incidents',
  '*',
  (query) => query.gte('created_at', incidentSince).lte('created_at', through)
    .in('signal', ['account_disconnected', 'auth_expired']).eq('state', 'completed'),
);
const profileIds = [...new Set(removalIncidents.map((row) => row.profile_id).filter(Boolean))];
if (!profileIds.length) throw new Error('Nenhum perfil removido encontrado para o marco informado.');

const eventMap = new Map();
for (let index = 0; index < profileIds.length; index += 20) {
  const rows = await fetchAll('instagram_observability_events', '*', (query) => query
    .lte('occurred_at', through).in('profile_id', profileIds.slice(index, index + 20)));
  for (const row of rows) eventMap.set(row.id, row);
}
const codeEvents = await fetchAll('instagram_observability_events', '*', (query) => query
  .lte('occurred_at', through)
  .or('provider_code.in.(account_disconnected,auth_expired),stable_code.in.(account_disconnected,auth_expired),message.ilike.%42804%,message.ilike.%instagram_observability_severity%'));
for (const row of codeEvents) eventMap.set(row.id, row);

const events = [...eventMap.values()];
const incidentIds = [...new Set(events.map((row) => row.incident_id).filter(Boolean))];
const [derivedIncidents, incidentProfiles, incidentEntities, incidentActions] = await Promise.all([
  fetchByIds('instagram_observability_incidents', '*', 'id', incidentIds),
  fetchByIds('instagram_observability_incident_profiles', '*', 'incident_id', incidentIds),
  fetchByIds('instagram_observability_incident_entities', '*', 'incident_id', incidentIds),
  fetchByIds('instagram_observability_incident_actions', '*', 'incident_id', incidentIds),
]);

const summary = {
  through,
  removalIncidents: removalIncidents.length,
  profiles: profileIds.length,
  derivedEvents: events.length,
  affectedDerivedIncidents: derivedIncidents.length,
};

if (!apply) {
  console.log(JSON.stringify({ mode: 'dry-run', summary }, null, 2));
  process.exit(0);
}

const directory = path.resolve('artifacts');
fs.mkdirSync(directory, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(directory, `zernio-terminal-observability-cleanup-backup-${stamp}.json`);
fs.writeFileSync(backupPath, `${JSON.stringify({ summary, profileIds, removalIncidents, events, derivedIncidents, incidentProfiles, incidentEntities, incidentActions }, null, 2)}\n`, { flag: 'wx' });

const deletedEvents = await deleteByIds('instagram_observability_events', 'id', events.map((row) => row.id));
if (deletedEvents !== events.length) throw new Error(`Exclusão parcial de eventos: ${deletedEvents}/${events.length}.`);

const remainingIncidentEvents = await fetchByIds('instagram_observability_events', 'incident_id', 'incident_id', incidentIds);
const retainedIncidentIds = new Set(remainingIncidentEvents.map((row) => row.incident_id));
const orphanIncidentIds = incidentIds.filter((id) => !retainedIncidentIds.has(id));
const deletedIncidents = await deleteByIds('instagram_observability_incidents', 'id', orphanIncidentIds);

const markerPath = path.join(directory, `zernio-terminal-observability-cleanup-marker-${stamp}.json`);
fs.writeFileSync(markerPath, `${JSON.stringify({ clearedThrough: through, executedAt: new Date().toISOString(), backupPath, deletedEvents, deletedIncidents, retainedMixedIncidents: incidentIds.length - orphanIncidentIds.length }, null, 2)}\n`, { flag: 'wx' });

console.log(JSON.stringify({ mode: 'apply', summary, backupPath, markerPath, deletedEvents, deletedIncidents, retainedMixedIncidents: incidentIds.length - orphanIncidentIds.length }, null, 2));
