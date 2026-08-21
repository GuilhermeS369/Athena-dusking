#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

const targetNames = [
  'STORY TESTE DANI 17-08',
  '15-08 35 LOIRINHA STORY 2',
  'STORY OFICIAL DANI 17-08 120MIN',
];
const startDate = process.argv.find((argument) => argument.startsWith('--start-date='))?.slice('--start-date='.length) ?? '2026-08-17';
const shouldApply = process.argv.includes('--apply');

if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new Error('Use --start-date=AAAA-MM-DD.');

for (const filePath of ['.env.local', '.env.worker.deploy']) {
  if (!fs.existsSync(filePath)) continue;
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

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) throw new Error('Credenciais do Supabase não encontradas.');
const supabase = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

function saoPauloDailyAt(dayOffset) {
  const [year, month, day] = startDate.split('-').map(Number);
  // Em agosto de 2026, São Paulo é UTC-03:00. A entrada é fixada para esta
  // correção operacional e o produto passará a calcular o fuso no banco.
  return new Date(Date.UTC(year, month - 1, day + dayOffset + 1, 0, 0, 0)).toISOString();
}

const { data: batches, error: batchesError } = await supabase
  .from('publication_batches')
  .select('id, organization_id, name, status')
  .in('name', targetNames)
  .order('created_at', { ascending: true });
if (batchesError) throw batchesError;
if ((batches ?? []).length !== targetNames.length) throw new Error(`Foram encontrados ${(batches ?? []).length} dos ${targetNames.length} lotes esperados.`);
const byName = new Map((batches ?? []).map((batch) => [batch.name, batch]));
if (targetNames.some((name) => !byName.has(name))) throw new Error('Há lote alvo ausente.');

const batchIds = targetNames.map((name) => byName.get(name).id);
const [{ data: items, error: itemsError }, { data: plans, error: plansError }] = await Promise.all([
  supabase.from('publication_items').select('id, batch_id, profile_id, status, execute_at').in('batch_id', batchIds).order('execute_at', { ascending: true }),
  supabase.from('bulk_publication_plans').select('id, batch_id, status, interval_minutes, duration_days').in('batch_id', batchIds),
]);
if (itemsError || plansError) throw itemsError ?? plansError;

const activeStatuses = new Set(['waiting', 'ready', 'failed', 'suspended']);
const planByBatch = new Map((plans ?? []).map((plan) => [plan.batch_id, plan]));
const changes = [];
for (const batchId of batchIds) {
  const plan = planByBatch.get(batchId);
  if (!plan) throw new Error(`Lote ${batchId} não possui plano compacto associado.`);
  const activeItems = (items ?? []).filter((item) => item.batch_id === batchId && activeStatuses.has(item.status));
  const blockedItems = (items ?? []).filter((item) => item.batch_id === batchId && ['preparing', 'publishing'].includes(item.status));
  if (blockedItems.length) throw new Error(`Lote ${batchId} tem ${blockedItems.length} item(ns) em processamento; nenhuma alteração foi aplicada.`);
  const byProfile = Map.groupBy(activeItems, (item) => item.profile_id);
  for (const [profileId, profileItems] of byProfile) {
    profileItems.sort((left, right) => (left.execute_at ?? '').localeCompare(right.execute_at ?? '') || left.id.localeCompare(right.id));
    profileItems.forEach((item, slotIndex) => changes.push({ itemId: item.id, batchId, profileId, slotIndex, executeAt: saoPauloDailyAt(slotIndex) }));
  }
}

const summary = {
  dryRun: !shouldApply,
  timeZone: 'America/Sao_Paulo',
  startDate,
  dailyTime: '21:00',
  batches: targetNames.map((name) => ({ name, batchId: byName.get(name).id, planId: planByBatch.get(byName.get(name).id).id })),
  changeCount: changes.length,
  perBatch: Object.fromEntries(batchIds.map((batchId) => [batchId, changes.filter((change) => change.batchId === batchId).length])),
  preview: changes.slice(0, 12),
};
if (!shouldApply) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

for (const change of changes) {
  const { error } = await supabase.from('publication_items').update({ execute_at: change.executeAt, status: 'waiting', next_attempt_at: null, lease_until: null, claimed_by: null }).eq('id', change.itemId);
  if (error) throw error;
}

for (const batchId of batchIds) {
  const plan = planByBatch.get(batchId);
  const batchChanges = changes.filter((change) => change.batchId === batchId);
  const byProfile = Map.groupBy(batchChanges, (change) => change.profileId);
  for (const [profileId, profileChanges] of byProfile) {
    profileChanges.sort((left, right) => left.slotIndex - right.slotIndex);
    const firstExecuteAt = profileChanges[0].executeAt;
    const lastExecuteAt = profileChanges.at(-1).executeAt;
    const { error } = await supabase.from('bulk_publication_plan_profiles').update({
      schedule_base_at: new Date(new Date(firstExecuteAt).getTime() - 1_440 * 60_000).toISOString(),
      first_execute_at: firstExecuteAt,
      last_execute_at: lastExecuteAt,
      total_slot_count: profileChanges.length,
      next_slot_index: profileChanges.length,
      generated_slot_count: profileChanges.length,
      status: 'completed',
    }).eq('plan_id', plan.id).eq('profile_id', profileId);
    if (error) throw error;
  }
  const { error: planError } = await supabase.from('bulk_publication_plans').update({ interval_minutes: 1440, duration_days: Math.max(...[...byProfile.values()].map((profileChanges) => profileChanges.length)) }).eq('id', plan.id);
  if (planError) throw planError;
}

const { data: verificationItems, error: verificationError } = await supabase.from('publication_items').select('batch_id, profile_id, execute_at, status').in('batch_id', batchIds).in('status', [...activeStatuses]);
if (verificationError) throw verificationError;
const invalid = (verificationItems ?? []).filter((item) => {
  const executeAt = item.execute_at ? new Date(item.execute_at) : null;
  return !executeAt || Number.isNaN(executeAt.getTime()) || executeAt.getUTCHours() !== 0 || executeAt.getUTCMinutes() !== 0 || executeAt.getUTCSeconds() !== 0;
});
if (invalid.length) throw new Error(`A verificação encontrou ${invalid.length} item(ns) fora de 21:00 em São Paulo.`);

console.log(JSON.stringify({ ...summary, dryRun: false, appliedAt: new Date().toISOString(), verification: { activeItemCount: (verificationItems ?? []).length, invalidTimeCount: invalid.length } }, null, 2));
