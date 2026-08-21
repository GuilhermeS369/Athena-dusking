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

const { data: failedItems, error: failedItemsError } = await supabase
  .from('publication_items')
  .select('id, organization_id, status, attempt_count')
  .eq('status', 'failed')
  .eq('last_error_code', 'zernio_request_failed')
  .eq('last_error_message', 'Variável obrigatória ausente: TOKEN_ENCRYPTION_KEY')
  .limit(100);

if (failedItemsError) throw failedItemsError;

const itemIds = (failedItems ?? []).map((item) => item.id);
if (itemIds.length === 0) {
  console.log(JSON.stringify({ requeued: 0, reason: 'no_matching_items' }));
  process.exit(0);
}

const { error: updateError } = await supabase
  .from('publication_items')
  .update({
    status: 'waiting',
    attempt_count: 0,
    next_attempt_at: null,
    claimed_by: null,
    lease_until: null,
    last_error_code: null,
    last_error_message: null,
  })
  .in('id', itemIds);

if (updateError) throw updateError;

const { error: eventError } = await supabase
  .from('publication_item_events')
  .insert(failedItems.map((item) => ({
    organization_id: item.organization_id,
    publication_item_id: item.id,
    event_type: 'retry_requested',
    previous_status: 'failed',
    status: 'waiting',
    actor_label: 'system:worker-encryption-config-repair',
    error_code: 'worker_configuration_repaired',
    error_message: 'Item reaberto sem consumir tentativa após correção da configuração local do worker.',
    metadata: { repair: 'missing_token_encryption_key' },
  })));

if (eventError) throw eventError;
console.log(JSON.stringify({ requeued: itemIds.length, itemIds }));
