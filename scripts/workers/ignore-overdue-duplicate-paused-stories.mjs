#!/usr/bin/env node

// Encerra apenas Stories vencidos em waiting dentro de lotes atualmente
// pausados porque a última falha do disjuntor foi conteúdo duplicado.
// Dry-run por padrão; --apply cria backup antes da primeira alteração.
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
const ALL_PAUSED = process.argv.includes('--all-paused');
const cutoff = new Date().toISOString();
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function fetchAll(table, columns, configure = (query) => query) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    let query = supabase.from(table).select(columns).order('id').range(from, from + 999);
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

const { data: breakers, error: breakersError } = await supabase
  .from('publication_batch_circuit_breakers')
  .select('*')
  .not('paused_at', 'is', null)
  .is('resumed_at', null);
if (breakersError) throw breakersError;
const lastFailures = await fetchByIds(
  'publication_items',
  'id,last_error_code,last_error_message,format',
  'id',
  breakers.map((row) => row.last_failure_item_id).filter(Boolean),
);
const failureById = new Map(lastFailures.map((row) => [row.id, row]));
const duplicateBreakers = breakers.filter((row) =>
  failureById.get(row.last_failure_item_id)?.last_error_message?.startsWith('Duplicate content detected.'),
);
const selectedBreakers = ALL_PAUSED ? breakers : duplicateBreakers;
const duplicateBatchIds = selectedBreakers.map((row) => row.batch_id);

const targets = duplicateBatchIds.length === 0
  ? []
  : await fetchAll('publication_items', '*', (query) =>
    query.in('batch_id', duplicateBatchIds)
      .eq('format', 'story')
      .eq('status', 'waiting')
      .lte('execute_at', cutoff)
      .is('archived_at', null),
  );
const targetIds = targets.map((row) => row.id);
const targetBatchIds = [...new Set(targets.map((row) => row.batch_id))];
const reservations = {
  daily: await fetchByIds('publication_profile_daily_reservations', '*', 'publication_item_id', targetIds),
  dispatch: await fetchByIds('publication_dispatch_rate_reservations', '*', 'publication_item_id', targetIds),
};

const summary = {
  mode: APPLY ? 'apply' : 'dry_run',
  scope: ALL_PAUSED ? 'all_paused_batches' : 'duplicate_paused_batches',
  cutoff,
  pausedDuplicateBatches: duplicateBatchIds.length,
  targetBatches: targetBatchIds.length,
  targetItems: targets.length,
  targetProfiles: new Set(targets.map((row) => row.profile_id)).size,
  targetOrganizations: new Set(targets.map((row) => row.organization_id)).size,
  reservations: { daily: reservations.daily.length, dispatch: reservations.dispatch.length },
};

if (!APPLY) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

if (targets.length === 0) {
  console.log(JSON.stringify({ ...summary, result: 'already_clean' }, null, 2));
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.resolve('artifacts', `overdue-duplicate-stories-before-ignore-${stamp}.json`);
fs.mkdirSync(path.dirname(backupPath), { recursive: true });
fs.writeFileSync(backupPath, JSON.stringify({
  backedUpAt: new Date().toISOString(),
  cutoff,
  duplicateBreakers,
  selectedBreakers,
  targets,
  reservations,
}, null, 2));

const ignored = [];
for (let index = 0; index < targetIds.length; index += 100) {
  const { data, error } = await supabase.from('publication_items').update({
    status: 'ignored',
    claimed_by: null,
    lease_until: null,
    next_attempt_at: null,
    last_error_code: ALL_PAUSED ? 'paused_batch_overdue_story_ignored' : 'duplicate_content_batch_overdue_ignored',
    last_error_message: ALL_PAUSED
      ? 'Story vencido ignorado durante a recuperação segura de um lote pausado.'
      : 'Story vencido ignorado porque o lote foi pausado após falhas de conteúdo duplicado.',
  }).in('id', targetIds.slice(index, index + 100))
    .eq('status', 'waiting')
    .lte('execute_at', cutoff)
    .select('id,organization_id,batch_id,profile_id,execute_at,status');
  if (error) throw error;
  ignored.push(...data);
}
if (ignored.length !== targets.length) {
  throw new Error(`Atualização parcial: ${ignored.length}/${targets.length} Stories foram ignorados.`);
}

const events = targets.map((row) => ({
  organization_id: row.organization_id,
  publication_item_id: row.id,
  event_type: 'ignored',
  previous_status: 'waiting',
  status: 'ignored',
  actor_label: ALL_PAUSED ? 'system: paused-batch-overdue-story-cleanup' : 'system: duplicate-content-overdue-cleanup',
  error_code: ALL_PAUSED ? 'paused_batch_overdue_story_ignored' : 'duplicate_content_batch_overdue_ignored',
  error_message: ALL_PAUSED
    ? 'Story vencido ignorado durante a recuperação segura de um lote pausado.'
    : 'Story vencido ignorado porque o lote foi pausado após falhas de conteúdo duplicado.',
  metadata: {
    action: ALL_PAUSED ? 'ignore_overdue_story_in_paused_batch' : 'ignore_overdue_story_in_duplicate_paused_batch',
    cutoff,
    execute_at: row.execute_at,
  },
}));
for (let index = 0; index < events.length; index += 250) {
  const { error } = await supabase.from('publication_item_events').insert(events.slice(index, index + 250));
  if (error) throw error;
}

for (const table of ['publication_profile_daily_reservations', 'publication_dispatch_rate_reservations']) {
  for (let index = 0; index < targetIds.length; index += 100) {
    const { error } = await supabase.from(table).delete().in('publication_item_id', targetIds.slice(index, index + 100));
    if (error) throw error;
  }
}

for (const batchId of targetBatchIds) {
  const { error } = await supabase.rpc('sync_publication_batch_status', { p_batch_id: batchId });
  if (error) throw error;
}

const remaining = await fetchByIds('publication_items', 'id,status,execute_at', 'id', targetIds);
const notIgnored = remaining.filter((row) => row.status !== 'ignored');
const futureWaiting = await fetchAll('publication_items', 'id,batch_id,format,status,execute_at', (query) =>
  query.in('batch_id', duplicateBatchIds).eq('status', 'waiting').gt('execute_at', cutoff),
);
const activeBreakersAfter = await fetchByIds(
  'publication_batch_circuit_breakers', 'batch_id,paused_at,resumed_at', 'batch_id', duplicateBatchIds,
);
if (notIgnored.length > 0) throw new Error(`Verificação encontrou ${notIgnored.length} alvos fora de ignored.`);

console.log(JSON.stringify({
  ...summary,
  result: 'ignored',
  backupPath,
  ignoredItems: ignored.length,
  insertedEvents: events.length,
  preservedFutureWaiting: futureWaiting.length,
  breakersStillPaused: activeBreakersAfter.filter((row) => row.paused_at && !row.resumed_at).length,
  verificationNotIgnored: notIgnored.length,
}, null, 2));
