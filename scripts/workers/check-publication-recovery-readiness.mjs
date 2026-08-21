#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

for (const filePath of ['.env.local', '.env.worker', '.env.worker.deploy']) loadEnvFile(filePath);

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    if (process.env[key]) continue;
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

const supabase = createClient(
  requiredEnv('NEXT_PUBLIC_SUPABASE_URL'),
  requiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const [organizations, settings, risks, cycles, queue] = await Promise.all([
  supabase.from('organizations').select('id, name').order('name'),
  supabase.from('publication_slot_recovery_settings').select('organization_id, enabled, max_items_per_cycle, min_safe_window_seconds, max_recovery_delay_seconds').order('organization_id'),
  supabase.from('publication_slot_risk_incidents').select('organization_id, batch_id, state, slot_execute_at, affected_item_count, overdue_seconds, next_slot_execute_at, decision_reason, updated_at, publication_batches(name)').order('updated_at', { ascending: false }).limit(100),
  supabase.from('publication_worker_cycle_events').select('worker_id, phase, started_at, completed_at, duration_ms, error_code, created_at').order('created_at', { ascending: false }).limit(20),
  supabase.rpc('get_publication_queue_operational_summary', { p_organization_id: null }),
]);

for (const result of [organizations, settings, risks, cycles, queue]) {
  if (result.error) throw result.error;
}

const organizationNameById = new Map((organizations.data ?? []).map((organization) => [organization.id, organization.name]));
const now = Date.now();
const riskRows = (risks.data ?? []).map((risk) => {
  const nextSlotAt = risk.next_slot_execute_at ? Date.parse(risk.next_slot_execute_at) : null;
  return {
    organization: organizationNameById.get(risk.organization_id) ?? risk.organization_id,
    state: risk.state,
    batch: Array.isArray(risk.publication_batches) ? risk.publication_batches[0]?.name ?? null : risk.publication_batches?.name ?? null,
    affectedItems: risk.affected_item_count,
    overdueSeconds: risk.overdue_seconds,
    decision: risk.decision_reason,
    safeWindowOpen: nextSlotAt === null || nextSlotAt > now,
    slotExecuteAt: risk.slot_execute_at,
    nextSlotExecuteAt: risk.next_slot_execute_at,
  };
});

console.log(JSON.stringify({
  checkedAt: new Date().toISOString(),
  organizationCount: organizations.data?.length ?? 0,
  recoverySettings: settings.data ?? [],
  atRiskSlots: riskRows.filter((risk) => risk.state === 'at_risk'),
  workerCycles: cycles.data ?? [],
  queue: queue.data ?? [],
}, null, 2));
