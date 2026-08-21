#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

const targetName = '17-08 35 LOIRINHA STORY 3';
const shouldApply = process.argv.includes('--apply');

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
  .select('id, organization_id, name, status')
  .eq('name', targetName)
  .order('created_at', { ascending: false })
  .limit(2);
if (batchesError) throw batchesError;
if ((batches ?? []).length !== 1) throw new Error(`Era esperado exatamente um lote chamado "${targetName}"; encontrados ${(batches ?? []).length}.`);

const batch = batches[0];
const [{ data: items, error: itemsError }, { data: plans, error: plansError }] = await Promise.all([
  supabase
    .from('publication_items')
    .select('id, status')
    .eq('organization_id', batch.organization_id)
    .eq('batch_id', batch.id),
  supabase
    .from('bulk_publication_plans')
    .select('id, status')
    .eq('organization_id', batch.organization_id)
    .eq('batch_id', batch.id),
]);
if (itemsError) throw itemsError;
if (plansError) throw plansError;
if ((plans ?? []).length > 1) throw new Error(`O lote ${batch.id} possui mais de um plano compacto; abortado.`);

const activeItems = (items ?? []).filter((item) => ['waiting', 'ready', 'failed', 'suspended'].includes(item.status));
const blockedItems = (items ?? []).filter((item) => ['preparing', 'publishing'].includes(item.status));
const unexpectedItems = (items ?? []).filter((item) => !['waiting', 'ready', 'failed', 'suspended', 'cancelled', 'published', 'ignored', 'removed'].includes(item.status));
if (blockedItems.length || unexpectedItems.length) {
  throw new Error(`Cancelamento bloqueado: ${blockedItems.length} item(ns) em processamento e ${unexpectedItems.length} em estado inesperado.`);
}

const plan = plans?.[0] ?? null;
const summary = {
  dryRun: !shouldApply,
  batch: { id: batch.id, name: batch.name, previousStatus: batch.status },
  plan: plan ? { id: plan.id, previousStatus: plan.status } : null,
  activeItemCount: activeItems.length,
  blockedItemCount: blockedItems.length,
};
if (!shouldApply) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

const now = new Date().toISOString();
if (activeItems.length) {
  const { error } = await supabase
    .from('publication_items')
    .update({ status: 'cancelled', cancelled_at: now, next_attempt_at: null, lease_until: null, claimed_by: null, creation_id: null })
    .in('id', activeItems.map((item) => item.id));
  if (error) throw error;
}

if (plan) {
  const [chunksResult, horizonsResult, profilePlansResult] = await Promise.all([
    supabase
      .from('bulk_publication_generation_chunks')
      .update({ status: 'cancelled', claimed_by: null, lease_until: null, completed_at: now })
      .eq('plan_id', plan.id)
      .in('status', ['queued', 'processing', 'paused', 'failed']),
    supabase
      .from('bulk_publication_profile_horizons')
      .update({ status: 'cancelled', released_at: now })
      .eq('plan_id', plan.id)
      .eq('status', 'active'),
    supabase
      .from('bulk_publication_plan_profiles')
      .update({ status: 'cancelled', suspension_reason: 'Lote Story duplicado cancelado por solicitação do usuário.' })
      .eq('plan_id', plan.id)
      .in('status', ['queued', 'generating', 'suspended', 'failed']),
  ]);
  if (chunksResult.error || horizonsResult.error || profilePlansResult.error) {
    throw chunksResult.error ?? horizonsResult.error ?? profilePlansResult.error;
  }
  const { error: planError } = await supabase
    .from('bulk_publication_plans')
    .update({ status: 'cancelled', completed_at: now })
    .eq('id', plan.id)
    .in('status', ['queued', 'generating', 'paused', 'completed', 'completed_with_errors', 'failed']);
  if (planError) throw planError;
}

const { error: batchError } = await supabase
  .from('publication_batches')
  .update({ status: 'cancelled' })
  .eq('id', batch.id)
  .in('status', ['queued', 'processing', 'completed', 'completed_with_errors']);
if (batchError) throw batchError;

const [{ data: verifiedItems, error: verifyItemsError }, { data: verifiedPlan, error: verifyPlanError }, { data: verifiedBatch, error: verifyBatchError }] = await Promise.all([
  supabase.from('publication_items').select('status').eq('batch_id', batch.id).in('status', ['waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended']),
  plan ? supabase.from('bulk_publication_plans').select('status').eq('id', plan.id).maybeSingle() : Promise.resolve({ data: null, error: null }),
  supabase.from('publication_batches').select('status').eq('id', batch.id).maybeSingle(),
]);
if (verifyItemsError || verifyPlanError || verifyBatchError) throw verifyItemsError ?? verifyPlanError ?? verifyBatchError;
if ((verifiedItems ?? []).length || verifiedPlan?.status !== 'cancelled' || verifiedBatch?.status !== 'cancelled') {
  throw new Error('A verificação posterior não confirmou o cancelamento completo do lote duplicado.');
}

console.log(JSON.stringify({ ...summary, dryRun: false, cancelledAt: now, verification: { activeItemCount: 0, planStatus: verifiedPlan?.status ?? null, batchStatus: verifiedBatch?.status } }, null, 2));
