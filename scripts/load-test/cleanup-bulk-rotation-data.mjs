#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

for (const filePath of ['.env.local', '.env.worker', '.env.worker.deploy']) {
  if (!fs.existsSync(filePath)) continue;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (process.env[key]) continue;
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

const organizationId = required('LOAD_TEST_ORGANIZATION_ID');
const loadTestId = required('LOAD_TEST_ID');
if (!/^[A-Za-z0-9._-]{1,80}$/.test(loadTestId)) {
  throw new Error('LOAD_TEST_ID deve conter apenas letras, números, ponto, hífen ou sublinhado (máximo de 80 caracteres).');
}
const prefix = `[BULK LOAD ${loadTestId}]`;
if (!process.argv.includes('--execute') || process.env.BULK_LOAD_ALLOW_CLEANUP !== 'true') {
  console.info(JSON.stringify({ mode: 'dry-run', organizationId, prefix, note: 'Use --execute e BULK_LOAD_ALLOW_CLEANUP=true após pausar a geração.' }, null, 2));
  process.exit(0);
}

const supabase = createClient(required('NEXT_PUBLIC_SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), { auth: { autoRefreshToken: false, persistSession: false } });
const [{ data: plans, error: plansError }, { data: batches, error: batchesError }] = await Promise.all([
  supabase.from('bulk_publication_plans').select('id, batch_id, status, name').eq('organization_id', organizationId).like('name', `${prefix}%`),
  supabase.from('publication_batches').select('id, status, name').eq('organization_id', organizationId).like('name', `${prefix}%`),
]);
if (plansError) throw plansError;
if (batchesError) throw batchesError;
if ((plans || []).some((plan) => ['queued', 'generating'].includes(plan.status))) throw new Error('Há planos ainda ativos. Pause o generation worker e cancele/finalize os planos antes da limpeza.');

const planIds = (plans || []).map((plan) => plan.id);
const batchIds = [...new Set([
  ...(plans || []).map((plan) => plan.batch_id),
  ...(batches || []).map((batch) => batch.id),
])];
if (!planIds.length && !batchIds.length) {
  console.info('[bulk-load-cleanup] nenhum plano ou lote encontrado');
  process.exit(0);
}

// bulk_publication_plans.batch_id usa ON DELETE RESTRICT. Excluir os planos
// primeiro aciona as cascatas dos snapshots/chunks e então libera os lotes.
if (planIds.length) {
  const { error: deletePlansError } = await supabase.from('bulk_publication_plans').delete().eq('organization_id', organizationId).in('id', planIds);
  if (deletePlansError) throw deletePlansError;
}
if (batchIds.length) {
  const { error: deleteBatchesError } = await supabase.from('publication_batches').delete().eq('organization_id', organizationId).in('id', batchIds);
  if (deleteBatchesError) {
    console.error(JSON.stringify({ orphanedBatchIds: batchIds, recovery: 'Execute novamente este cleanup com o mesmo LOAD_TEST_ID.' }, null, 2));
    throw deleteBatchesError;
  }
}
console.info(JSON.stringify({ cleanedPlans: planIds.length, cleanedBatches: batchIds.length, organizationId, loadTestId }, null, 2));
