#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

const ORGANIZATION_ID = '695be08f-3084-4046-a91d-9052b2a1582b';
const TARGET_PLAN_IDS = [
  '15a3772f-dcf9-4c1e-b259-07a9214579ed', // Lari
  '9fa015bd-90dd-49b9-9a76-de14d23dbc62', // Marcos
  '00ab90e8-3471-48a8-a9a7-2826a97a4efe', // Julio
];
const APPLY = process.argv.includes('--apply');
const RECOVER_OFFLINE_PROFILES = process.argv.includes('--recover-offline-profiles');

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
  const value = process.env[name];
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
};
const supabase = createClient(required('NEXT_PUBLIC_SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { autoRefreshToken: false, persistSession: false },
});

const [{ data: plans, error: plansError }, { data: chunks, error: chunksError }] = await Promise.all([
  supabase.from('bulk_publication_plans').select('id, name, organization_id, status, expected_publications, generated_publications, failed_publications, completed_at').eq('organization_id', ORGANIZATION_ID).in('id', TARGET_PLAN_IDS).order('created_at'),
  supabase.from('bulk_publication_generation_chunks').select('id, plan_id, plan_profile_id, profile_id, status, slot_start, slot_count, next_slot_index, generated_items, failed_items, consecutive_failure_count, retry_exhausted_at, last_error_message, claimed_by, lease_until, completed_at').in('plan_id', TARGET_PLAN_IDS).order('plan_id').order('chunk_ordinal'),
]);
if (plansError || chunksError) throw plansError ?? chunksError;

const targetPlanProfileIds = [...new Set((chunks ?? []).map((chunk) => chunk.plan_profile_id))];
const targetProfileIds = [...new Set((chunks ?? []).map((chunk) => chunk.profile_id))];
const [{ data: planProfiles, error: planProfilesError }, { data: profiles, error: profilesError }] = await Promise.all([
  supabase.from('bulk_publication_plan_profiles').select('id, plan_id, profile_id, organization_id, status, generated_slot_count, failed_slot_count').in('id', targetPlanProfileIds),
  supabase.from('instagram_profiles').select('id, organization_id, username, status, deleted_at').in('id', targetProfileIds),
]);
if (planProfilesError || profilesError) throw planProfilesError ?? profilesError;

const planProfilesById = new Map((planProfiles ?? []).map((planProfile) => [planProfile.id, planProfile]));
const profilesById = new Map((profiles ?? []).map((profile) => [profile.id, profile]));

// A falha pode ocorrer antes ou depois de algum progresso. A retomada é segura
// porque a materialização usa idempotency_key; ainda assim, só liberamos um
// chunk se seus contadores internos forem coerentes e ele estiver totalmente
// desvinculado de qualquer worker.
const hasCoherentProgress = (chunk) => {
  const slotStart = Number(chunk.slot_start);
  const slotCount = Number(chunk.slot_count);
  const nextSlotIndex = Number(chunk.next_slot_index);
  const generatedItems = Number(chunk.generated_items);
  const failedItems = Number(chunk.failed_items);
  const remainingItems = slotStart + slotCount - nextSlotIndex;

  return Number.isSafeInteger(slotStart)
    && Number.isSafeInteger(slotCount)
    && Number.isSafeInteger(nextSlotIndex)
    && Number.isSafeInteger(generatedItems)
    && Number.isSafeInteger(failedItems)
    && slotCount > 0
    && nextSlotIndex >= slotStart
    && nextSlotIndex <= slotStart + slotCount
    && generatedItems === nextSlotIndex - slotStart
    && failedItems === remainingItems;
};

const recoverable = (chunks ?? []).filter((chunk) => (
  // A rotina de cancelamento do plano pode marcar o chunk terminal como
  // `cancelled` preservando o diagnóstico original. Ambos são terminais e
  // seguros para a mesma recuperação estritamente filtrada.
  ['failed', 'cancelled'].includes(chunk.status)
  && chunk.retry_exhausted_at !== null
  && chunk.last_error_message === 'bulk_publication_horizon_conflict'
  && chunk.claimed_by === null
  && chunk.lease_until === null
  && hasCoherentProgress(chunk)
));
const rejected = (chunks ?? []).filter((chunk) => !recoverable.includes(chunk));
const recoveryRejectionReasons = (chunk) => {
  const reasons = [];
  if (!['failed', 'cancelled'].includes(chunk.status)) reasons.push(`status=${chunk.status}`);
  if (chunk.retry_exhausted_at === null) reasons.push('retry_not_exhausted');
  if (chunk.last_error_message !== 'bulk_publication_horizon_conflict') reasons.push(`error=${chunk.last_error_message ?? 'null'}`);
  if (chunk.claimed_by !== null) reasons.push(`claimed_by=${chunk.claimed_by}`);
  if (chunk.lease_until !== null) reasons.push(`lease_until=${chunk.lease_until}`);
  if (!hasCoherentProgress(chunk)) reasons.push('inconsistent_progress_counters');
  return reasons;
};
const horizonConflictChunks = (chunks ?? []).filter((chunk) => (
  chunk.last_error_message === 'bulk_publication_horizon_conflict'
  || recoverable.includes(chunk)
));
const unavailableProfiles = horizonConflictChunks.flatMap((chunk) => {
  const profile = profilesById.get(chunk.profile_id);
  if (profile && profile.deleted_at === null && profile.status === 'online') return [];
  return [{
    chunkId: chunk.id,
    planProfileId: chunk.plan_profile_id,
    profileId: chunk.profile_id,
    username: profile?.username ?? null,
    profileStatus: profile?.status ?? null,
    deletedAt: profile?.deleted_at ?? null,
  }];
});

if (rejected.some((chunk) => chunk.status === 'processing' || chunk.lease_until !== null || chunk.claimed_by !== null)) {
  throw new Error('Há chunks não recuperáveis ainda reivindicados; recuperação abortada para não sobrescrever trabalho em curso.');
}
if (APPLY && unavailableProfiles.length && !RECOVER_OFFLINE_PROFILES) {
  throw new Error(`Recuperação abortada: ${unavailableProfiles.length} perfil(is) alvo(s) estão offline ou removidos. Use --recover-offline-profiles somente após reconectar esses perfis.`);
}

const result = {
  mode: APPLY ? (RECOVER_OFFLINE_PROFILES ? 'apply_with_offline_profiles' : 'apply') : 'dry_run',
  checkedAt: new Date().toISOString(),
  plans,
  planProfiles,
  instagramProfiles: profiles,
  profileOrganizationMismatches: (planProfiles ?? []).flatMap((planProfile) => {
    const profile = (profiles ?? []).find((candidate) => candidate.id === planProfile.profile_id);
    const plan = (plans ?? []).find((candidate) => candidate.id === planProfile.plan_id);
    if (!profile || !plan || planProfile.organization_id === profile.organization_id && planProfile.organization_id === plan.organization_id) return [];
    return [{
      planProfileId: planProfile.id,
      planId: planProfile.plan_id,
      profileId: planProfile.profile_id,
      username: profile.username,
      planOrganizationId: plan.organization_id,
      planProfileOrganizationId: planProfile.organization_id,
      instagramProfileOrganizationId: profile.organization_id,
    }];
  }),
  recoverableChunkCount: recoverable.length,
  recoverableByPlan: Object.fromEntries((plans ?? []).map((plan) => [plan.name, recoverable.filter((chunk) => chunk.plan_id === plan.id).length])),
  unavailableProfiles,
  nonRecoverableChunkCount: rejected.length,
  nonRecoverableChunks: rejected.map((chunk) => ({
    id: chunk.id,
    planId: chunk.plan_id,
    planProfileId: chunk.plan_profile_id,
    profileId: chunk.profile_id,
    status: chunk.status,
    slotStart: chunk.slot_start,
    slotCount: chunk.slot_count,
    nextSlotIndex: chunk.next_slot_index,
    generatedItems: chunk.generated_items,
    failedItems: chunk.failed_items,
    consecutiveFailures: chunk.consecutive_failure_count,
    retryExhaustedAt: chunk.retry_exhausted_at,
    error: chunk.last_error_message,
    recoveryRejectionReasons: recoveryRejectionReasons(chunk),
  })),
  recovered: [],
};

if (APPLY && recoverable.length) {
  const now = new Date().toISOString();
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
    .in('id', recoverable.map((chunk) => chunk.id))
    .in('status', ['failed', 'cancelled'])
    .eq('last_error_message', 'bulk_publication_horizon_conflict')
    .select('id, plan_id, status');
  if (resetChunksError) throw resetChunksError;

  const profilesToReset = recoverable.filter((chunk) => {
    const profile = profilesById.get(chunk.profile_id);
    return RECOVER_OFFLINE_PROFILES || (profile?.deleted_at === null && profile?.status === 'online');
  });
  const { data: resetProfiles, error: resetProfilesError } = await supabase
    .from('bulk_publication_plan_profiles')
    .update({ status: 'queued', failed_slot_count: 0 })
    .in('id', profilesToReset.map((chunk) => chunk.plan_profile_id))
    .in('status', ['failed', 'cancelled'])
    .select('id, plan_id, status');
  if (resetProfilesError) throw resetProfilesError;

  const { data: resetHorizons, error: resetHorizonsError } = await supabase
    .from('bulk_publication_profile_horizons')
    .update({ status: 'active', released_at: null })
    .in('plan_profile_id', profilesToReset.map((chunk) => chunk.plan_profile_id))
    .eq('status', 'cancelled')
    .select('id, plan_id, status');
  if (resetHorizonsError) throw resetHorizonsError;

  const { data: resetPlans, error: resetPlansError } = await supabase
    .from('bulk_publication_plans')
    .update({ status: 'queued', failed_publications: 0, completed_at: null, updated_at: now })
    .in('id', TARGET_PLAN_IDS)
    .in('status', ['completed_with_errors', 'failed'])
    .select('id, name, status, failed_publications');
  if (resetPlansError) throw resetPlansError;
  result.recovered = { chunks: resetChunks ?? [], profiles: resetProfiles ?? [], horizons: resetHorizons ?? [], plans: resetPlans ?? [] };
}

console.log(JSON.stringify(result, null, 2));
