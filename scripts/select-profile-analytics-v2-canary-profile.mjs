#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

for (const filePath of ['.env.local', '.env.worker']) {
  if (!fs.existsSync(filePath)) continue;
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const separator = rawLine.indexOf('=');
    if (separator <= 0 || rawLine.trim().startsWith('#')) continue;
    const key = rawLine.slice(0, separator).trim();
    if (!process.env[key]) process.env[key] = rawLine.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
  }
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);
const jobId = process.argv[2];
if (!jobId) throw new Error('Informe o UUID do job legado de referência.');
const requestedLimit = Number.parseInt(process.argv[3] ?? '1', 10);
const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 10) : 1;
const { data, error } = await supabase.from('profile_analytics_refresh_job_items')
  .select('profile_id')
  .eq('job_id', jobId)
  .eq('status', 'synced')
  .order('processed_at', { ascending: false })
  .limit(limit);
if (error) throw error;
console.log((data ?? []).map((item) => item.profile_id).join(','));
