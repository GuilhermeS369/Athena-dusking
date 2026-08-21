#!/usr/bin/env node

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

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) throw new Error('Credenciais do Supabase não encontradas.');

const supabase = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const start = process.argv.find((argument) => argument.startsWith('--start='))?.slice('--start='.length) ?? '2026-08-15T19:15:00.000Z';
const end = process.argv.find((argument) => argument.startsWith('--end='))?.slice('--end='.length) ?? '2026-08-15T19:17:00.000Z';

const { data: events, error: eventsError } = await supabase
  .from('publication_item_events')
  .select('id, publication_item_id, event_type, previous_status, status, actor_label, error_code, error_message, metadata, created_at')
  .eq('error_code', 'missed_bulk_slot_ignored')
  .gte('created_at', start)
  .lt('created_at', end)
  .order('created_at', { ascending: true })
  .limit(500);
if (eventsError) throw eventsError;

const itemIds = (events ?? []).map((event) => event.publication_item_id);
const { data: items, error: itemsError } = itemIds.length === 0
  ? { data: [], error: null }
  : await supabase
    .from('publication_items')
    .select('id, organization_id, batch_id, profile_id, idempotency_key, format, status, execute_at, attempt_count, creation_id, next_attempt_at, claimed_by, lease_until, last_error_code, last_error_message, published_at, created_at, updated_at, instagram_profiles(username, provider, status)')
    .in('id', itemIds)
    .order('execute_at', { ascending: true });
if (itemsError) throw itemsError;

const batchIds = [...new Set((items ?? []).map((item) => item.batch_id).filter(Boolean))];
const profileIds = [...new Set((items ?? []).map((item) => item.profile_id).filter(Boolean))];
const affectedProfileId = (items ?? []).find((item) => item.instagram_profiles?.username === 'devasconcelosmariana210')?.profile_id ?? null;
const affectedPlanId = (items ?? []).find((item) => item.instagram_profiles?.username === 'devasconcelosmariana210')?.idempotency_key?.split(':')[1] ?? null;
const [plansResult, nearbyItemsResult, heartbeatsResult, connectionsResult] = await Promise.all([
  batchIds.length === 0
    ? Promise.resolve({ data: [], error: null })
    : supabase
      .from('bulk_publication_plans')
      .select('id, name, status, batch_id, interval_minutes, expected_publications, generated_publications, suspended_publications, ignored_publications, failed_publications, created_at, updated_at')
      .in('batch_id', batchIds),
  batchIds.length === 0
    ? Promise.resolve({ data: [], error: null })
    : supabase
      .from('publication_items')
      .select('id, batch_id, profile_id, idempotency_key, status, execute_at, attempt_count, creation_id, last_error_code, last_error_message, published_at, created_at, updated_at, instagram_profiles(username, provider, status)')
      .in('batch_id', batchIds)
      .gte('execute_at', '2026-08-15T18:00:00.000Z')
      .lt('execute_at', '2026-08-15T22:00:00.000Z')
      .order('execute_at', { ascending: true })
      .limit(500),
  supabase
    .from('publication_worker_heartbeats')
    .select('worker_id, worker_kind, status, dry_run, last_seen_at, last_error_message, metadata')
    .eq('worker_kind', 'publication')
    .order('last_seen_at', { ascending: false })
    .limit(50),
  profileIds.length === 0
    ? Promise.resolve({ data: [], error: null })
    : supabase
      .from('instagram_profiles')
      .select('id, username, provider, status, zernio_account_id, zernio_connection_id, zernio_connections(id, status, last_error_message, updated_at)')
      .in('id', profileIds),
]);
for (const [name, result] of Object.entries({ plansResult, nearbyItemsResult, heartbeatsResult, connectionsResult })) {
  if (result.error) throw new Error(`${name}: ${result.error.message}`);
}

console.log(JSON.stringify({
  checkedAt: new Date().toISOString(),
  readOnlyScope: { start, end, targetErrorCode: 'missed_bulk_slot_ignored' },
  ignoredEvents: events ?? [],
  ignoredItems: items ?? [],
  plans: plansResult.data ?? [],
  nearbyBatchItems: nearbyItemsResult.data ?? [],
  currentPublicationHeartbeats: heartbeatsResult.data ?? [],
  zernioProfileConnections: connectionsResult.data ?? [],
}, null, 2));

if (affectedProfileId && affectedPlanId) {
  const [{ data: profilePlan, error: profilePlanError }, { data: futureItems, error: futureItemsError }, { data: workerEvents, error: workerEventsError }] = await Promise.all([
    supabase
      .from('bulk_publication_plan_profiles')
      .select('plan_id, profile_id, ordinal, status, first_execute_at, generated_slot_count, created_at, updated_at')
      .eq('plan_id', affectedPlanId)
      .eq('profile_id', affectedProfileId)
      .maybeSingle(),
    supabase
      .from('publication_items')
      .select('id, status, execute_at, attempt_count, creation_id, last_error_code, last_error_message, published_at, created_at, updated_at')
      .eq('profile_id', affectedProfileId)
      .gte('execute_at', end)
      .order('execute_at', { ascending: true })
      .limit(10),
    supabase
      .from('publication_item_events')
      .select('publication_item_id, event_type, previous_status, status, actor_label, error_code, error_message, metadata, created_at')
      .eq('publication_item_id', (items ?? []).find((item) => item.profile_id === affectedProfileId)?.id ?? '')
      .order('created_at', { ascending: true }),
  ]);
  for (const [name, result] of Object.entries({ profilePlan: { error: profilePlanError }, futureItems: { error: futureItemsError }, workerEvents: { error: workerEventsError } })) {
    if (result.error) throw new Error(`${name}: ${result.error.message}`);
  }
  console.log(JSON.stringify({
    affectedProfileDetail: {
      profileId: affectedProfileId,
      username: 'devasconcelosmariana210',
      planId: affectedPlanId,
      profilePlan,
      futureItems: futureItems ?? [],
      itemEvents: workerEvents ?? [],
    },
  }, null, 2));
}
