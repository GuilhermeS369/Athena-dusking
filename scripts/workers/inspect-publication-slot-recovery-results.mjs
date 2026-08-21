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

const { data: incidents, error: incidentsError } = await supabase
  .from('publication_slot_risk_incidents')
  .select('organization_id, batch_id, slot_execute_at, state, affected_item_count, decision_reason, updated_at')
  .eq('state', 'at_risk')
  .order('updated_at', { ascending: false })
  .limit(20);

if (incidentsError) throw incidentsError;

const slots = await Promise.all((incidents ?? []).map(async (incident) => {
  const { data: items, error } = await supabase
    .from('publication_items')
    .select('id, status, attempt_count, execute_at, idempotency_key, creation_id, next_attempt_at, last_error_code, last_error_message, claimed_by, lease_until, instagram_profiles(username, status)')
    .eq('organization_id', incident.organization_id)
    .eq('batch_id', incident.batch_id)
    .eq('execute_at', incident.slot_execute_at)
    .like('idempotency_key', 'bulk:%')
    .order('created_at');
  if (error) throw error;

  return {
    incident,
    statusTotals: (items ?? []).reduce((totals, item) => {
      totals[item.status] = (totals[item.status] ?? 0) + 1;
      return totals;
    }, {}),
    nonWaitingItems: (items ?? []).filter((item) => item.status !== 'waiting').map((item) => ({
      profile: Array.isArray(item.instagram_profiles)
        ? item.instagram_profiles[0]?.username ?? null
        : item.instagram_profiles?.username ?? null,
      status: item.status,
      attemptCount: item.attempt_count,
      nextAttemptAt: item.next_attempt_at,
      errorCode: item.last_error_code,
      errorMessage: item.last_error_message,
      claimedBy: item.claimed_by,
      leaseUntil: item.lease_until,
    })),
    waitingEligibilitySample: (items ?? []).filter((item) => item.status === 'waiting').slice(0, 10).map((item) => ({
      profile: Array.isArray(item.instagram_profiles)
        ? item.instagram_profiles[0]?.username ?? null
        : item.instagram_profiles?.username ?? null,
      profileStatus: Array.isArray(item.instagram_profiles)
        ? item.instagram_profiles[0]?.status ?? null
        : item.instagram_profiles?.status ?? null,
      executeAt: item.execute_at,
      bulkKey: item.idempotency_key?.startsWith('bulk:') ?? false,
      creationId: item.creation_id,
      nextAttemptAt: item.next_attempt_at,
      leaseUntil: item.lease_until,
    })),
  };
}));

console.log(JSON.stringify({ checkedAt: new Date().toISOString(), slots }, null, 2));
