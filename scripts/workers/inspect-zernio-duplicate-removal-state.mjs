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

const identities = (process.argv.find((value) => value.startsWith('--usernames='))?.slice(12) ?? '').split(',').filter(Boolean);
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const incidentsResult = await supabase
  .from('zernio_profile_disconnection_incidents')
  .select('id, organization_id, normalized_identity, state, remote_result, remote_http_status, retained_profile_id, retained_zernio_connection_id, retained_zernio_account_id, removed_zernio_connection_id, removed_zernio_account_id, removal_preflight_at, removal_preflight_by')
  .in('normalized_identity', identities);
if (incidentsResult.error) throw incidentsResult.error;
const jobsResult = await supabase
  .from('zernio_profile_recycling_jobs')
  .select('id, incident_id, status, attempt_count, claimed_by, lease_until, last_outcome')
  .in('incident_id', incidentsResult.data.map((incident) => incident.id));
if (jobsResult.error) throw jobsResult.error;
console.log(JSON.stringify({ incidents: incidentsResult.data, jobs: jobsResult.data }, null, 2));
