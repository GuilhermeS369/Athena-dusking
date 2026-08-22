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
    if (process.env[key]) continue;
    process.env[key] = rawLine.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
  }
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

const organizationId = requiredEnv('PROFILE_ANALYTICS_V2_CANARY_ORGANIZATION_ID');
const profileIds = requiredEnv('PROFILE_ANALYTICS_V2_CANARY_PROFILE_IDS')
  .split(',').map((value) => value.trim()).filter(Boolean);
const canaryKey = process.env.PROFILE_ANALYTICS_V2_CANARY_KEY?.trim()
  || `current-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;

const supabase = createClient(
  requiredEnv('NEXT_PUBLIC_SUPABASE_URL'),
  requiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const { data, error } = await supabase.rpc('enqueue_profile_analytics_refresh_v2_live_current_canary', {
  p_organization_id: organizationId,
  p_profile_ids: profileIds,
  p_canary_key: canaryKey,
});
if (error) throw error;
console.log(JSON.stringify({ organizationId, profileIds, canaryKey, result: data }, null, 2));
