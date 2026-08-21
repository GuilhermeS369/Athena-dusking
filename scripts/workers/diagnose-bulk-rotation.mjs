#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

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
const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const requestedBatchId = process.argv.find((argument) => argument.startsWith('--batch-id='))?.slice('--batch-id='.length) ?? null;

const [plansResult, chunksResult, heartbeatsResult, summaryResult] = await Promise.all([
  supabase
  .from('bulk_publication_plans')
    .select('id, name, status, batch_id, interval_minutes, expected_publications, generated_publications, suspended_publications, ignored_publications, failed_publications, created_at, updated_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(20),
  supabase
    .from('bulk_publication_generation_chunks')
    .select('id, plan_id, status, lease_until, last_progress_at, created_at, updated_at')
    .order('updated_at', { ascending: false })
    .limit(100),
  supabase
    .from('publication_worker_heartbeats')
    .select('worker_id, worker_kind, status, dry_run, last_seen_at, last_error_message, metadata')
    .in('worker_id', ['athena-vps-generation-1', 'athena-vps-publication-1'])
    .order('worker_id'),
  supabase.rpc('get_bulk_rotation_operational_summary', { p_organization_id: null }),
]);

for (const [name, result] of Object.entries({ plansResult, chunksResult, heartbeatsResult, summaryResult })) {
  if (result.error) throw new Error(`${name}: ${result.error.code ?? ''} ${result.error.message}`);
}

const plans = plansResult.data ?? [];
const planIds = new Set(plans.map((plan) => plan.id));
const chunks = (chunksResult.data ?? []).filter((chunk) => planIds.size === 0 || planIds.has(chunk.plan_id));

const selectedPlan = requestedBatchId
  ? plans.find((plan) => plan.batch_id === requestedBatchId) ?? null
  : plans[0] ?? null;

let batchDiagnostics = null;
if (selectedPlan) {
  const [itemsResult, profilePlansResult, breakerResult] = await Promise.all([
    supabase
      .from('publication_items')
      .select('id, profile_id, status, execute_at, attempt_count, next_attempt_at, last_error_code, last_error_message')
      .eq('batch_id', selectedPlan.batch_id)
      .order('execute_at', { ascending: true })
      .limit(20000),
    supabase
      .from('bulk_publication_plan_profiles')
      .select('profile_id, ordinal, status, first_execute_at, generated_slot_count')
      .eq('plan_id', selectedPlan.id)
      .order('ordinal', { ascending: true }),
    supabase
      .from('publication_batch_circuit_breakers')
      .select('batch_id, consecutive_failures, paused_at, paused_reason, last_failure_item_id, updated_at')
      .eq('batch_id', selectedPlan.batch_id)
      .maybeSingle(),
  ]);
  if (itemsResult.error || profilePlansResult.error || breakerResult.error) {
    throw new Error(`batchDiagnostics: ${itemsResult.error?.message ?? profilePlansResult.error?.message ?? breakerResult.error?.message}`);
  }

  const itemRows = itemsResult.data ?? [];
  const slots = new Map();
  const profileSchedules = new Map();
  for (const item of itemRows) {
    const slot = item.execute_at ?? 'sem_horario';
    const summary = slots.get(slot) ?? { itemCount: 0, profileIds: new Set(), statuses: {} };
    summary.itemCount += 1;
    summary.profileIds.add(item.profile_id);
    summary.statuses[item.status] = (summary.statuses[item.status] ?? 0) + 1;
    slots.set(slot, summary);
  }
  for (const profilePlan of profilePlansResult.data ?? []) {
    const schedule = profileSchedules.get(profilePlan.first_execute_at) ?? { profileIds: [], statuses: {} };
    schedule.profileIds.push(profilePlan.profile_id);
    schedule.statuses[profilePlan.status] = (schedule.statuses[profilePlan.status] ?? 0) + 1;
    profileSchedules.set(profilePlan.first_execute_at, schedule);
  }

  const firstSlotAt = [...profileSchedules.keys()].sort()[0] ?? null;
  const firstSlotProfileIds = new Set(profileSchedules.get(firstSlotAt)?.profileIds ?? []);
  const firstSlotResult = firstSlotAt
    ? await supabase
      .from('publication_items')
      .select('id, profile_id, status, execute_at, attempt_count, next_attempt_at, last_error_code, last_error_message', { count: 'exact' })
      .eq('batch_id', selectedPlan.batch_id)
      .eq('execute_at', firstSlotAt)
      .limit(1000)
    : { data: [], count: 0, error: null };
  if (firstSlotResult.error) throw new Error(`firstSlotDiagnostics: ${firstSlotResult.error.message}`);
  const firstSlotItems = firstSlotResult.data ?? [];
  const materializedFirstSlotProfileIds = new Set(firstSlotItems.map((item) => item.profile_id));
  const firstSlotWindowEnd = new Date(new Date(firstSlotAt).getTime() + selectedPlan.interval_minutes * 60_000).toISOString();
  const firstSlotWindowResult = firstSlotAt
    ? await supabase
      .from('publication_items')
      .select('id, profile_id, status, execute_at, attempt_count, next_attempt_at, last_error_code, last_error_message', { count: 'exact' })
      .eq('batch_id', selectedPlan.batch_id)
      .gte('execute_at', firstSlotAt)
      .lt('execute_at', firstSlotWindowEnd)
      .order('execute_at', { ascending: true })
      .limit(1000)
    : { data: [], count: 0, error: null };
  if (firstSlotWindowResult.error) throw new Error(`firstSlotWindowDiagnostics: ${firstSlotWindowResult.error.message}`);
  const firstSlotWindowItems = firstSlotWindowResult.data ?? [];
  const firstSlotWindowProfileIds = new Set(firstSlotWindowItems.map((item) => item.profile_id));
  const recoveredItemsResult = await supabase
    .from('publication_items')
    .select('id, profile_id, status, execute_at, missed_schedule_recovery_count, last_error_code, last_error_message', { count: 'exact' })
    .eq('batch_id', selectedPlan.batch_id)
    .eq('missed_schedule_recovery_count', 1)
    .order('execute_at', { ascending: true })
    .limit(1000);
  if (recoveredItemsResult.error) throw new Error(`recoveredItemsDiagnostics: ${recoveredItemsResult.error.message}`);

  batchDiagnostics = {
    batchId: selectedPlan.batch_id,
    materializedItemCount: itemRows.length,
    profilePlanCount: (profilePlansResult.data ?? []).length,
    slots: [...slots.entries()].slice(0, 12).map(([executeAt, summary]) => ({
      executeAt,
      itemCount: summary.itemCount,
      distinctProfiles: summary.profileIds.size,
      statuses: summary.statuses,
    })),
    firstProfileSlots: [...profileSchedules.entries()].map(([executeAt, summary]) => ({
      executeAt,
      profileCount: summary.profileIds.length,
      statuses: summary.statuses,
      profileIds: summary.profileIds,
    })),
    firstSlotVerification: firstSlotAt ? {
      executeAt: firstSlotAt,
      windowEnd: firstSlotWindowEnd,
      expectedProfiles: firstSlotProfileIds.size,
      exactMaterializedItemCount: firstSlotResult.count ?? firstSlotItems.length,
      materializedDistinctProfiles: materializedFirstSlotProfileIds.size,
      missingProfileIds: [...firstSlotProfileIds].filter((profileId) => !materializedFirstSlotProfileIds.has(profileId)),
      items: firstSlotItems,
    } : null,
    firstSlotWindowVerification: firstSlotAt ? {
      itemCount: firstSlotWindowResult.count ?? firstSlotWindowItems.length,
      distinctProfiles: firstSlotWindowProfileIds.size,
      missingProfileIds: [...firstSlotProfileIds].filter((profileId) => !firstSlotWindowProfileIds.has(profileId)),
      items: firstSlotWindowItems,
    } : null,
    missedScheduleRecoveries: {
      count: recoveredItemsResult.count ?? (recoveredItemsResult.data ?? []).length,
      items: recoveredItemsResult.data ?? [],
    },
    terminalFailures: itemRows.filter((item) => item.status === 'failed').map((item) => ({
      id: item.id,
      executeAt: item.execute_at,
      attemptCount: item.attempt_count,
      code: item.last_error_code,
      message: item.last_error_message,
    })),
    circuitBreaker: breakerResult.data ?? {
      consecutive_failures: 0,
      paused_at: null,
      paused_reason: null,
    },
  };
}

console.log(JSON.stringify({
  checkedAt: new Date().toISOString(),
  scope: { plansCreatedSince: since },
  plans,
  chunks,
  generationWorker: (heartbeatsResult.data ?? []).find((heartbeat) => heartbeat.worker_id === 'athena-vps-generation-1') ?? null,
  publicationWorker: (heartbeatsResult.data ?? []).find((heartbeat) => heartbeat.worker_id === 'athena-vps-publication-1') ?? null,
  operationalSummary: summaryResult.data ?? null,
  batchDiagnostics,
}, null, 2));
