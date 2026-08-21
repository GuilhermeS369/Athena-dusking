#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

for (const filePath of ['.env.local', '.env.worker', '.env.worker.deploy']) {
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

const { data: batches, error: batchError } = await supabase
  .from('publication_batches')
  .select('id, organization_id, name, status, created_at')
  .ilike('name', '%OFICIAL LUIZ MIGUEL%')
  .order('created_at', { ascending: false })
  .limit(20);
if (batchError) throw batchError;
const batchIds = (batches ?? []).map((batch) => batch.id);
const [{ data: plans, error: planError }, { data: profilePlans, error: profilePlanError }, { data: items, error: itemError }] = await Promise.all([
  batchIds.length ? supabase.from('bulk_publication_plans').select('id, batch_id, name, status, format, schedule_mode, daily_time, interval_minutes, duration_days, slots_per_profile, created_at').in('batch_id', batchIds) : { data: [], error: null },
  batchIds.length ? supabase.from('bulk_publication_plan_profiles').select('plan_id, profile_id, first_execute_at, last_execute_at, total_slot_count, schedule_base_at').in('plan_id', (await supabase.from('bulk_publication_plans').select('id').in('batch_id', batchIds)).data?.map((plan) => plan.id) ?? []) : { data: [], error: null },
  batchIds.length ? supabase.from('publication_items').select('batch_id, profile_id, format, status, execute_at').in('batch_id', batchIds).in('status', ['waiting', 'ready', 'preparing', 'publishing']).order('execute_at', { ascending: true }).limit(100000) : { data: [], error: null },
]);
if (planError || profilePlanError || itemError) throw planError ?? profilePlanError ?? itemError;
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), batches, plans, profilePlans, items }, null, 2));
