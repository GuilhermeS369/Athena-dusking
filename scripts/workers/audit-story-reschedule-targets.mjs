#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

const targetNames = [
  'STORY TESTE DANI 17-08',
  'STORY OFICIAL DANI 17-08 120MIN',
  '17-08 35 LOIRINHA STORY 3',
  '15-08 35 LOIRINHA STORY 2',
];

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

const supabase = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: batches, error: batchesError } = await supabase
  .from('publication_batches')
  .select('id, organization_id, name, status, timezone, scheduled_for, created_at, updated_at')
  .in('name', targetNames)
  .order('created_at', { ascending: true });
if (batchesError) throw batchesError;

const batchIds = (batches ?? []).map((batch) => batch.id);
const [itemsResult, plansResult] = await Promise.all([
  batchIds.length
    ? supabase
      .from('publication_items')
      .select('id, batch_id, profile_id, format, status, execute_at, caption, created_at')
      .in('batch_id', batchIds)
      .order('execute_at', { ascending: true, nullsFirst: false })
      .limit(100000)
    : { data: [], error: null },
  batchIds.length
    ? supabase
      .from('bulk_publication_plans')
      .select('id, batch_id, name, status, format, origin_type, origin_group_id, caption, interval_minutes, duration_days, order_mode, rotation_seed, profile_count, media_count, expected_publications, generated_publications, first_execute_at:bulk_publication_plan_profiles(first_execute_at), last_execute_at:bulk_publication_plan_profiles(last_execute_at), profile_ids:bulk_publication_plan_profiles(profile_id)')
      .in('batch_id', batchIds)
    : { data: [], error: null },
]);
if (itemsResult.error) throw itemsResult.error;
if (plansResult.error) throw plansResult.error;

const items = itemsResult.data ?? [];
const plansByBatch = new Map((plansResult.data ?? []).map((plan) => [plan.batch_id, plan]));
const targets = (batches ?? []).map((batch) => {
  const batchItems = items.filter((item) => item.batch_id === batch.id);
  const activeItems = batchItems.filter((item) => ['waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended'].includes(item.status));
  const executeAts = activeItems.map((item) => item.execute_at).filter(Boolean).sort();
  const plan = plansByBatch.get(batch.id) ?? null;
  return {
    batch,
    activeItemCount: activeItems.length,
    profileCount: new Set(activeItems.map((item) => item.profile_id)).size,
    firstActiveExecuteAt: executeAts[0] ?? null,
    lastActiveExecuteAt: executeAts.at(-1) ?? null,
    activeStatuses: Object.fromEntries(Object.entries(Object.groupBy(activeItems, (item) => item.status)).map(([status, grouped]) => [status, grouped.length])),
    plan,
  };
});

console.log(JSON.stringify({
  checkedAt: new Date().toISOString(),
  requestedNames: targetNames,
  foundCount: targets.length,
  missingNames: targetNames.filter((name) => !targets.some((target) => target.batch.name === name)),
  targets,
}, null, 2));
