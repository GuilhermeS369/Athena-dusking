#!/usr/bin/env node
import fs from 'node:fs';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

for (const filePath of ['.env.local', '.env.worker.deploy']) {
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

const argument = (name) => process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1)?.trim() ?? null;
const jobId = argument('--job-id');
const workerId = argument('--worker-id');
const errorCode = argument('--error-code');
const message = argument('--message');
if (!jobId || !workerId || !errorCode || !message) throw new Error('Informe job, worker, código e mensagem.');
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data, error } = await supabase.rpc('complete_zernio_profile_recycling', {
  p_job_id: jobId,
  p_worker_id: workerId,
  p_remote_outcome: 'terminal_error',
  p_http_status: 409,
  p_request_id: null,
  p_error_code: errorCode,
  p_error_message: message,
});
if (error) throw error;
console.log(JSON.stringify(data, null, 2));
