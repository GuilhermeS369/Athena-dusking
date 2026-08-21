#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

const PLAN_ID = '4d2597a9-9c56-454a-9105-f339a79bd828';
const BATCH_ID = '71703a97-22b2-441a-9fc6-eb139f339d24';
const FIRST_EXECUTE_AT = '2026-08-18T10:00:00.000Z'; // 18/08 às 07:00 em São Paulo
const LAST_EXECUTE_AT = '2026-08-19T10:00:00.000Z'; // 19/08 às 07:00 em São Paulo
const SCHEDULE_BASE_AT = '2026-08-17T10:00:00.000Z';
const apply = process.argv.includes('--apply');

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

const [{ data: plan, error: planError }, { data: profiles, error: profilesError }, { data: chunks, error: chunksError }, { count: itemCount, error: itemsError }] = await Promise.all([
  supabase.from('bulk_publication_plans').select('id, batch_id, name, status, schedule_mode, daily_time, duration_days, slots_per_profile').eq('id', PLAN_ID).maybeSingle(),
  supabase.from('bulk_publication_plan_profiles').select('id, profile_id, first_execute_at, last_execute_at, next_slot_index, generated_slot_count').eq('plan_id', PLAN_ID),
  supabase.from('bulk_publication_generation_chunks').select('id, plan_profile_id, next_slot_index, generated_items, status').eq('plan_id', PLAN_ID),
  supabase.from('publication_items').select('*', { count: 'exact', head: true }).eq('batch_id', BATCH_ID).in('status', ['waiting', 'ready', 'preparing', 'publishing']),
]);
if (planError || profilesError || chunksError || itemsError) throw planError ?? profilesError ?? chunksError ?? itemsError;

const preflight = {
  plan,
  profileCount: profiles?.length ?? 0,
  chunkCount: chunks?.length ?? 0,
  activeItemCount: itemCount ?? 0,
  generatedSlots: (profiles ?? []).reduce((total, profile) => total + Number(profile.generated_slot_count), 0),
};

if (!plan || plan.batch_id !== BATCH_ID || !['queued', 'generating'].includes(plan.status) || plan.schedule_mode !== 'daily_time' || plan.daily_time !== '07:00:00' || String(plan.duration_days) !== '2' || String(plan.slots_per_profile) !== '2') {
  throw new Error(`Plano não está no estado diário esperado: ${JSON.stringify(preflight)}`);
}
if ((itemCount ?? 0) > (profiles?.length ?? 0) * 2 || (profiles ?? []).some((profile) => Number(profile.generated_slot_count) > 2) || (chunks ?? []).some((chunk) => Number(chunk.next_slot_index) > 2 || Number(chunk.generated_items) > 2)) {
  throw new Error(`O lote possui mais slots materializados do que o plano permite: ${JSON.stringify(preflight)}`);
}

if (!apply) {
  console.log(JSON.stringify({ dryRun: true, target: { firstExecuteAt: FIRST_EXECUTE_AT, lastExecuteAt: LAST_EXECUTE_AT }, preflight }, null, 2));
  process.exit(0);
}

const { data: repair, error: repairError } = await supabase.rpc('repair_luiz_miguel_daily_story_start', {
  p_plan_id: PLAN_ID,
  p_first_execute_at: FIRST_EXECUTE_AT,
});
if (repairError) throw repairError;

const [{ data: verifiedProfiles, error: verifiedProfilesError }, { data: verifiedHorizons, error: verifiedHorizonsError }] = await Promise.all([
  supabase.from('bulk_publication_plan_profiles').select('id, first_execute_at, last_execute_at, schedule_base_at').eq('plan_id', PLAN_ID),
  supabase.from('bulk_publication_profile_horizons').select('plan_profile_id, first_execute_at, reserved_through, reserved_from').eq('plan_id', PLAN_ID).eq('status', 'active'),
]);
if (verifiedProfilesError || verifiedHorizonsError) throw verifiedProfilesError ?? verifiedHorizonsError;

const validProfiles = (verifiedProfiles ?? []).every((profile) => profile.schedule_base_at === SCHEDULE_BASE_AT && profile.first_execute_at === FIRST_EXECUTE_AT && profile.last_execute_at === LAST_EXECUTE_AT);
const validHorizons = (verifiedHorizons ?? []).length === (profiles ?? []).length && (verifiedHorizons ?? []).every((horizon) => horizon.reserved_from === SCHEDULE_BASE_AT && horizon.first_execute_at === FIRST_EXECUTE_AT && horizon.reserved_through === LAST_EXECUTE_AT);
if (!validProfiles || !validHorizons) throw new Error('A verificação posterior não confirmou todos os horários corrigidos.');

console.log(JSON.stringify({ applied: true, repair, target: { firstExecuteAt: FIRST_EXECUTE_AT, lastExecuteAt: LAST_EXECUTE_AT }, preflight, verification: { profileCount: verifiedProfiles.length, horizonCount: verifiedHorizons.length, validProfiles, validHorizons } }, null, 2));
