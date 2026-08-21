#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

const PLAN_NAME = 'REELS OFICIAL LUIZ MIGUEL 17-08 70MIN PARTE 2';
const APPLY = process.argv.includes('--apply');

for (const filePath of ['.env.local', '.env.worker', '.env.worker.deploy']) {
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

const required = (name) => {
  if (!process.env[name]) throw new Error(`Variável obrigatória ausente: ${name}`);
  return process.env[name];
};
const supabase = createClient(required('NEXT_PUBLIC_SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: plans, error: plansError } = await supabase
  .from('bulk_publication_plans')
  .select('id, name, organization_id, status, format, expected_publications, generated_publications, failed_publications, batch_id, created_at, completed_at')
  .eq('name', PLAN_NAME);
if (plansError) throw plansError;
if ((plans ?? []).length !== 1) throw new Error(`Esperado exatamente um plano com este nome; encontrados: ${(plans ?? []).length}.`);

const [plan] = plans;
const [{ data: chunks, error: chunksError }, { data: planProfiles, error: planProfilesError }] = await Promise.all([
  supabase
    .from('bulk_publication_generation_chunks')
    .select('id, plan_id, plan_profile_id, profile_id, status, slot_start, slot_count, next_slot_index, generated_items, failed_items, consecutive_failure_count, retry_exhausted_at, last_error_message, claimed_by, lease_until')
    .eq('plan_id', plan.id)
    .order('chunk_ordinal'),
  supabase
    .from('bulk_publication_plan_profiles')
    .select('id, profile_id, status, generated_slot_count, failed_slot_count, suspension_reason')
    .eq('plan_id', plan.id),
]);
if (chunksError || planProfilesError) throw chunksError ?? planProfilesError;

const profileIds = [...new Set((chunks ?? []).map((chunk) => chunk.profile_id))];
const { data: profiles, error: profilesError } = await supabase
  .from('instagram_profiles')
  .select('id, username, organization_id, status, deleted_at')
  .in('id', profileIds);
if (profilesError) throw profilesError;

const profilesById = new Map((profiles ?? []).map((profile) => [profile.id, profile]));
const horizonConflictChunks = (chunks ?? []).filter((chunk) => chunk.last_error_message === 'bulk_publication_horizon_conflict');
const recoverableChunks = horizonConflictChunks.filter((chunk) => {
  const profile = profilesById.get(chunk.profile_id);
  const slotStart = Number(chunk.slot_start);
  const slotCount = Number(chunk.slot_count);
  const nextSlotIndex = Number(chunk.next_slot_index);
  const generatedItems = Number(chunk.generated_items);
  const failedItems = Number(chunk.failed_items);
  const terminal = ['failed', 'cancelled'].includes(chunk.status);
  const coherent = Number.isSafeInteger(slotStart)
    && Number.isSafeInteger(slotCount)
    && Number.isSafeInteger(nextSlotIndex)
    && generatedItems === nextSlotIndex - slotStart
    && failedItems === slotStart + slotCount - nextSlotIndex;

  return terminal
    && chunk.retry_exhausted_at !== null
    && chunk.claimed_by === null
    && chunk.lease_until === null
    && profile?.status === 'online'
    && profile.deleted_at === null
    && coherent;
});
const unavailableConflictChunks = horizonConflictChunks.filter((chunk) => !recoverableChunks.includes(chunk));
const organizationMismatches = (chunks ?? []).flatMap((chunk) => {
  const profile = profilesById.get(chunk.profile_id);
  if (!profile || profile.organization_id === plan.organization_id) return [];
  return [{
    chunkId: chunk.id,
    planProfileId: chunk.plan_profile_id,
    profileId: chunk.profile_id,
    username: profile.username,
    planOrganizationId: plan.organization_id,
    profileOrganizationId: profile.organization_id,
  }];
});

const recovery = { chunks: [], planProfiles: [], horizons: [], plan: null };
if (APPLY && recoverableChunks.length) {
  const chunkIds = recoverableChunks.map((chunk) => chunk.id);
  const planProfileIds = recoverableChunks.map((chunk) => chunk.plan_profile_id);
  const { data: resetChunks, error: resetChunksError } = await supabase
    .from('bulk_publication_generation_chunks')
    .update({
      status: 'queued',
      failed_items: 0,
      consecutive_failure_count: 0,
      retry_exhausted_at: null,
      last_error_message: null,
      claimed_by: null,
      lease_until: null,
      completed_at: null,
    })
    .in('id', chunkIds)
    .in('status', ['failed', 'cancelled'])
    .eq('last_error_message', 'bulk_publication_horizon_conflict')
    .select('id, status');
  if (resetChunksError) throw resetChunksError;

  const { data: resetPlanProfiles, error: resetPlanProfilesError } = await supabase
    .from('bulk_publication_plan_profiles')
    .update({ status: 'queued', failed_slot_count: 0, suspended_at: null, suspension_reason: null })
    .in('id', planProfileIds)
    .in('status', ['failed', 'cancelled'])
    .select('id, status');
  if (resetPlanProfilesError) throw resetPlanProfilesError;

  const { data: resetHorizons, error: resetHorizonsError } = await supabase
    .from('bulk_publication_profile_horizons')
    .update({ status: 'active', released_at: null })
    .in('plan_profile_id', planProfileIds)
    .in('status', ['cancelled', 'released'])
    .select('id, status');
  if (resetHorizonsError) throw resetHorizonsError;

  const { data: resetPlan, error: resetPlanError } = await supabase
    .from('bulk_publication_plans')
    .update({ status: 'queued', completed_at: null, updated_at: new Date().toISOString() })
    .eq('id', plan.id)
    .eq('status', 'completed_with_errors')
    .select('id, status');
  if (resetPlanError) throw resetPlanError;
  recovery.chunks = resetChunks ?? [];
  recovery.planProfiles = resetPlanProfiles ?? [];
  recovery.horizons = resetHorizons ?? [];
  recovery.plan = resetPlan?.[0] ?? null;
}

console.log(JSON.stringify({
  mode: APPLY ? 'apply' : 'dry_run',
  checkedAt: new Date().toISOString(),
  plan,
  chunks: (chunks ?? []).map((chunk) => ({
    ...chunk,
    profile: profilesById.get(chunk.profile_id) ?? null,
  })),
  horizonConflictChunks: horizonConflictChunks.map((chunk) => ({
    ...chunk,
    profile: profilesById.get(chunk.profile_id) ?? null,
  })),
  recoverableChunks: recoverableChunks.map((chunk) => ({ id: chunk.id, profile: profilesById.get(chunk.profile_id) })),
  unavailableConflictChunks: unavailableConflictChunks.map((chunk) => ({ id: chunk.id, profile: profilesById.get(chunk.profile_id) })),
  organizationMismatches,
  planProfiles,
  recovery,
}, null, 2));
