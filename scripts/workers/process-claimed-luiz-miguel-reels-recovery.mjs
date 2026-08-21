#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

const WORKER_ID = 'manual-bulk-recovery-debug';
const PLAN_ID = 'c8a22eb1-af2b-4b21-acda-20fb06b5842b';

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

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const { data: chunks, error: chunksError } = await supabase
  .from('bulk_publication_generation_chunks')
  .select('id, plan_id, status, claimed_by, lease_until')
  .eq('plan_id', PLAN_ID)
  .eq('status', 'processing')
  .eq('claimed_by', WORKER_ID);
if (chunksError) throw chunksError;

const outcomes = [];
for (const chunk of chunks ?? []) {
  const { data, error } = await supabase.rpc('process_bulk_rotation_generation_chunk', {
    p_chunk_id: chunk.id,
    p_worker_id: WORKER_ID,
    p_step_size: 500,
  });
  if (error) {
    const { data: failure, error: failureError } = await supabase.rpc('fail_bulk_rotation_generation_chunk', {
      p_chunk_id: chunk.id,
      p_worker_id: WORKER_ID,
      p_error_message: error.message,
      p_max_failures: 3,
    });
    outcomes.push({ chunkId: chunk.id, ok: false, error, failure, failureError });
  } else outcomes.push({ chunkId: chunk.id, ok: true, data });
}

console.log(JSON.stringify({ workerId: WORKER_ID, processed: outcomes.length, outcomes }, null, 2));
