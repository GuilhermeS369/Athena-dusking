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

const organizationId = process.argv.find((argument) => argument.startsWith('--organization-id='))?.slice('--organization-id='.length);
const batchName = process.argv.find((argument) => argument.startsWith('--batch-name='))?.slice('--batch-name='.length) ?? 'REELS OFICIAL LUIZ MIGUEL 17-08 120MIN';
const groupName = process.argv.find((argument) => argument.startsWith('--group-name='))?.slice('--group-name='.length) ?? 'Miguel';
if (!organizationId || !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Informe --organization-id e configure as credenciais Supabase.');

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const pageSize = 1_000;
async function fetchAllPages(buildQuery) {
  const firstPage = await buildQuery().range(0, pageSize - 1);
  if (firstPage.error) throw firstPage.error;
  const rows = [...(firstPage.data ?? [])];
  const total = firstPage.count ?? rows.length;
  for (let offset = pageSize; offset < total; offset += pageSize) {
    const page = await buildQuery().range(offset, offset + pageSize - 1);
    if (page.error) throw page.error;
    rows.push(...(page.data ?? []));
    if ((page.data ?? []).length < pageSize) break;
  }
  return rows;
}

const [{ data: batches, error: batchError }, { data: groups, error: groupError }] = await Promise.all([
  supabase.from('publication_batches').select('id, name, status, created_at').eq('organization_id', organizationId).eq('name', batchName),
  supabase.from('profile_groups').select('id, name, profile_group_members(profile_id)').eq('organization_id', organizationId).eq('name', groupName).is('deleted_at', null),
]);
if (batchError || groupError) throw batchError ?? groupError;
const batch = batches?.[0];
const group = groups?.[0];
if (!batch || !group) throw new Error(`Lote ou grupo não encontrado: lote=${batchName}; grupo=${groupName}.`);

const { data: plan, error: planError } = await supabase
  .from('bulk_publication_plans')
  .select('id, status, format, slots_per_profile, interval_minutes, duration_days')
  .eq('batch_id', batch.id)
  .maybeSingle();
if (planError) throw planError;

const [planProfilesResult, items, profilesResult, allActiveItems] = await Promise.all([
  plan
    ? supabase.from('bulk_publication_plan_profiles').select('profile_id, status, generated_slot_count, total_slot_count, first_execute_at, last_execute_at').eq('plan_id', plan.id)
    : Promise.resolve({ data: [], error: null }),
  fetchAllPages(() => supabase.from('publication_items').select('profile_id, status, format, execute_at', { count: 'exact' }).eq('batch_id', batch.id).order('execute_at', { ascending: true }).order('id', { ascending: true })),
  supabase.from('instagram_profiles').select('id, username, status, deleted_at').eq('organization_id', organizationId),
  fetchAllPages(() => supabase.from('publication_items').select('profile_id, batch_id, status, format, execute_at', { count: 'exact' }).eq('organization_id', organizationId).in('status', ['waiting', 'ready', 'preparing', 'publishing']).gt('execute_at', new Date().toISOString()).order('execute_at', { ascending: true }).order('id', { ascending: true })),
]);
if (planProfilesResult.error || profilesResult.error) throw planProfilesResult.error ?? profilesResult.error;

const now = Date.now();
const groupMemberIds = new Set((group.profile_group_members ?? []).map((member) => member.profile_id));
const profileById = new Map((profilesResult.data ?? []).map((profile) => [profile.id, profile]));
const planProfileById = new Map((planProfilesResult.data ?? []).map((profile) => [profile.profile_id, profile]));
const itemsByProfileId = new Map();
for (const item of items) {
  const current = itemsByProfileId.get(item.profile_id) ?? [];
  current.push(item);
  itemsByProfileId.set(item.profile_id, current);
}
const coverage = [...planProfileById.keys()].map((profileId) => {
  const items = itemsByProfileId.get(profileId) ?? [];
  const active = items.filter((item) => ['waiting', 'ready', 'preparing', 'publishing'].includes(item.status) && item.execute_at && new Date(item.execute_at).getTime() > now);
  const counts = Object.fromEntries(['waiting', 'ready', 'preparing', 'publishing', 'published', 'failed', 'cancelled', 'suspended'].map((status) => [status, items.filter((item) => item.status === status).length]));
  const planProfile = planProfileById.get(profileId);
  const profile = profileById.get(profileId);
  return {
    profileId,
    username: profile?.username ?? null,
    isCurrentMiguelMember: groupMemberIds.has(profileId),
    currentProfileStatus: profile?.status ?? null,
    deletedAt: profile?.deleted_at ?? null,
    planProfileStatus: planProfile?.status ?? null,
    plannedSlots: planProfile?.total_slot_count ?? 0,
    generatedSlots: planProfile?.generated_slot_count ?? 0,
    planFirstExecuteAt: planProfile?.first_execute_at ?? null,
    planLastExecuteAt: planProfile?.last_execute_at ?? null,
    activeFutureReels: active.filter((item) => item.format === 'reel').length,
    firstFutureReelAt: active.filter((item) => item.format === 'reel').at(0)?.execute_at ?? null,
    lastFutureReelAt: active.filter((item) => item.format === 'reel').at(-1)?.execute_at ?? null,
    itemStatuses: counts,
  };
});
const summary = {
  planProfiles: coverage.length,
  currentMiguelMembers: groupMemberIds.size,
  planProfilesStillInMiguel: coverage.filter((entry) => entry.isCurrentMiguelMember).length,
  planProfilesMissingFromMiguel: coverage.filter((entry) => !entry.isCurrentMiguelMember).length,
  currentMiguelProfilesWithFutureReels: coverage.filter((entry) => entry.isCurrentMiguelMember && entry.activeFutureReels > 0).length,
  futureReelsForCurrentMiguel: coverage.filter((entry) => entry.isCurrentMiguelMember).reduce((sum, entry) => sum + entry.activeFutureReels, 0),
  futureReelsForProfilesNoLongerInMiguel: coverage.filter((entry) => !entry.isCurrentMiguelMember).reduce((sum, entry) => sum + entry.activeFutureReels, 0),
};
const activeItemsByBatchId = new Map();
for (const item of allActiveItems) {
  const current = activeItemsByBatchId.get(item.batch_id) ?? [];
  current.push(item);
  activeItemsByBatchId.set(item.batch_id, current);
}
const activeBatchIds = [...activeItemsByBatchId.keys()];
const { data: activeBatches, error: activeBatchesError } = activeBatchIds.length
  ? await supabase.from('publication_batches').select('id, name, status').in('id', activeBatchIds)
  : { data: [], error: null };
if (activeBatchesError) throw activeBatchesError;
const currentMiguelFutureByBatch = (activeBatches ?? []).map((activeBatch) => {
  const items = (activeItemsByBatchId.get(activeBatch.id) ?? []).filter((item) => groupMemberIds.has(item.profile_id) && item.format === 'reel');
  return {
    ...activeBatch,
    currentMiguelFutureReels: items.length,
    distinctCurrentMiguelProfiles: new Set(items.map((item) => item.profile_id)).size,
    firstExecuteAt: items[0]?.execute_at ?? null,
    lastExecuteAt: items.at(-1)?.execute_at ?? null,
  };
}).filter((activeBatch) => activeBatch.currentMiguelFutureReels > 0);

console.log(JSON.stringify({ checkedAt: new Date().toISOString(), batch, group: { id: group.id, name: group.name }, plan, summary, currentMiguelFutureByBatch, coverage }, null, 2));
