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

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

const supabase = createClient(requiredEnv('NEXT_PUBLIC_SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { autoRefreshToken: false, persistSession: false },
});
const canaryKey = requiredEnv('PROFILE_ANALYTICS_V2_CANARY_KEY');
const organizationId = requiredEnv('PROFILE_ANALYTICS_V2_CANARY_ORGANIZATION_ID');
const sourceClass = (process.env.PROFILE_ANALYTICS_V2_CANARY_SOURCE_CLASS ?? 'current').trim().toLowerCase();
if (!['current', 'daily', 'posts'].includes(sourceClass)) throw new Error('Classe de canário inválida.');

async function rows(query, label) {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data ?? [];
}

const items = await rows(
  supabase.from('profile_analytics_refresh_v2_items')
    .select('id,organization_id,profile_id,source_class,execution_mode,status,attempts,max_attempts,claimed_by,lease_token,lease_until,last_error_class,last_error_code,last_error_message,metadata,created_at,completed_at')
    .eq('organization_id', organizationId)
    .like('idempotency_key', `live-${sourceClass}-canary:${canaryKey}:%`)
    .order('created_at', { ascending: true }),
  'items',
);
const itemIds = items.map((item) => item.id);
const events = itemIds.length === 0 ? [] : await rows(
  supabase.from('profile_analytics_refresh_v2_item_events')
    .select('item_id,profile_id,source_class,execution_mode,event_type,attempt_number,worker_id,lease_token,error_class,error_code,duration_ms,metadata,created_at')
    .in('item_id', itemIds)
    .order('created_at', { ascending: true }),
  'events',
);
const profileIds = items.map((item) => item.profile_id);
const runs = profileIds.length === 0 ? [] : await rows(
  supabase.from('profile_analytics_sync_runs')
    .select('profile_id,sync_kind,status,skipped,error_code,error_message,metadata,started_at,finished_at')
    .eq('organization_id', organizationId)
    .in('profile_id', profileIds)
    .eq('sync_kind', `profile_analytics_${sourceClass}`)
    .order('started_at', { ascending: false })
    .limit(20),
  'runs',
);
const watermarks = profileIds.length === 0 ? [] : await rows(
  supabase.from('profile_analytics_source_watermarks')
    .select('profile_id,source_class,last_success_at,last_attempt_at,next_refresh_at,consecutive_failures,last_status,last_error_class,metadata')
    .eq('organization_id', organizationId)
    .in('profile_id', profileIds)
    .eq('source_class', sourceClass),
  'watermarks',
);

const archives = profileIds.length === 0 ? [] : await rows(
  supabase.from('profile_analytics_payload_archives')
    .select('id,profile_id,source_class,payload_sha256,captured_at,retain_until,metadata')
    .eq('organization_id', organizationId)
    .in('profile_id', profileIds)
    .eq('source_class', sourceClass)
    .order('captured_at', { ascending: false }),
  'archives',
);

console.log(JSON.stringify({ measuredAt: new Date().toISOString(), organizationId, canaryKey, sourceClass, items, events, runs, watermarks, archives }, null, 2));
