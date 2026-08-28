#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

for (const filePath of ['.env.local', '.env.worker.deploy']) {
  if (!fs.existsSync(filePath)) continue;
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const separator = rawLine.indexOf('=');
    if (separator <= 0 || rawLine.trimStart().startsWith('#')) continue;
    const key = rawLine.slice(0, separator).trim();
    if (!process.env[key]) process.env[key] = rawLine.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  }
}

const apply = process.argv.includes('--apply');
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const { data: targets, error } = await supabase
  .from('publication_items')
  .select('*')
  .eq('status', 'failed')
  .not('creation_id', 'is', null)
  .in('last_error_code', ['zernio_recovery_confirmation_timeout'])
  .order('execute_at');
if (error) throw error;

const summary = {
  mode: apply ? 'apply' : 'dry_run',
  targets: targets.length,
  formats: targets.reduce((counts, item) => {
    counts[item.format] = (counts[item.format] ?? 0) + 1;
    return counts;
  }, {}),
  batches: new Set(targets.map((item) => item.batch_id)).size,
};
if (!apply || targets.length === 0) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.resolve('artifacts', `failed-zernio-creations-before-poll-${stamp}.json`);
fs.mkdirSync(path.dirname(backupPath), { recursive: true });
fs.writeFileSync(backupPath, JSON.stringify({ backedUpAt: new Date().toISOString(), targets }, null, 2));

const now = new Date().toISOString();
const ids = targets.map((item) => item.id);
const updated = [];
for (let index = 0; index < ids.length; index += 100) {
  const { data, error: updateError } = await supabase
    .from('publication_items')
    .update({ status: 'waiting', next_attempt_at: now, claimed_by: null, lease_until: null })
    .in('id', ids.slice(index, index + 100))
    .eq('status', 'failed')
    .not('creation_id', 'is', null)
    .select('id,organization_id,batch_id,status,creation_id');
  if (updateError) throw updateError;
  updated.push(...data);
}
if (updated.length !== targets.length) throw new Error(`Reabertura parcial: ${updated.length}/${targets.length}.`);

const events = targets.map((item) => ({
  organization_id: item.organization_id,
  publication_item_id: item.id,
  event_type: 'retry_requested',
  previous_status: 'failed',
  status: 'waiting',
  actor_label: 'system: confirmed-zernio-creation-poll-recovery',
  error_code: 'zernio_creation_poll_reactivated',
  error_message: 'Criação Zernio conhecida devolvida ao polling; nenhuma nova criação será enviada.',
  metadata: { creation_id: item.creation_id, previous_error_code: item.last_error_code },
}));
for (let index = 0; index < events.length; index += 250) {
  const { error: eventError } = await supabase.from('publication_item_events').insert(events.slice(index, index + 250));
  if (eventError) throw eventError;
}

console.log(JSON.stringify({ ...summary, backupPath, reactivated: updated.length, insertedEvents: events.length }, null, 2));
