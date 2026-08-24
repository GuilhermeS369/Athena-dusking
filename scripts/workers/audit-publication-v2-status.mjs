#!/usr/bin/env node

import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

for (const filePath of ['.env.local', '.env.worker']) {
  if (!fs.existsSync(filePath)) continue;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0 || line.trim().startsWith('#')) continue;
    const key = line.slice(0, separator).trim();
    if (process.env[key]) continue;
    process.env[key] = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
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

async function exactCount(query) {
  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

async function main() {
  const now = new Date();
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60_000);
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60_000);
  const oneDayAhead = new Date(now.getTime() + 24 * 60 * 60_000);

  const { data: organizations, error: organizationError } = await supabase
    .from('organizations')
    .select('id, name')
    .ilike('name', '%VINI%FARMANDO%CASH%')
    .limit(5);
  if (organizationError) throw organizationError;

  const preparationWithin24Hours = {};
  for (const status of ['pending', 'preparing', 'ready', 'blocked']) {
    preparationWithin24Hours[status] = await exactCount(
      supabase
        .from('publication_items')
        .select('id', { count: 'exact', head: true })
        .eq('pipeline_version', 2)
        .in('status', ['waiting', 'ready'])
        .eq('preparation_status', status)
        .lte('execute_at', oneDayAhead.toISOString()),
    );
  }

  const recentDue = {};
  for (const format of ['reel', 'story', 'image', 'carousel']) {
    recentDue[format] = {};
    for (const status of ['waiting', 'ready', 'preparing', 'publishing', 'published', 'failed', 'ignored', 'cancelled']) {
      recentDue[format][status] = await exactCount(
        supabase
          .from('publication_items')
          .select('id', { count: 'exact', head: true })
          .eq('pipeline_version', 2)
          .eq('format', format)
          .eq('status', status)
          .gte('execute_at', twoHoursAgo.toISOString())
          .lte('execute_at', now.toISOString()),
      );
    }
  }

  const slaAlerts = {
    open: await exactCount(supabase.from('publication_dispatch_sla_alerts').select('id', { count: 'exact', head: true }).eq('state', 'open')),
    resolvedLast24Hours: await exactCount(
      supabase.from('publication_dispatch_sla_alerts').select('id', { count: 'exact', head: true }).eq('state', 'resolved').gte('resolved_at', oneDayAgo.toISOString()),
    ),
  };

  const { data: heartbeats, error: heartbeatError } = await supabase
    .from('publication_worker_heartbeats')
    .select('worker_id, status, last_seen_at, last_error_message, metadata')
    .ilike('worker_id', '%publication%')
    .order('last_seen_at', { ascending: false })
    .limit(3);
  if (heartbeatError) throw heartbeatError;

  const { data: recentIgnoredItems, error: ignoredError } = await supabase
    .from('publication_items')
    .select('id, batch_id, profile_id, format, execute_at, updated_at, last_error_code, last_error_message, instagram_profiles(username)')
    .eq('pipeline_version', 2)
    .eq('status', 'ignored')
    .gte('execute_at', twoHoursAgo.toISOString())
    .lte('execute_at', now.toISOString())
    .order('updated_at', { ascending: false })
    .limit(20);
  if (ignoredError) throw ignoredError;

  console.log(JSON.stringify({
    checkedAt: now.toISOString(),
    organizations,
    preparationWithin24Hours,
    recentDueLast2Hours: recentDue,
    slaAlerts,
    heartbeats,
    recentIgnoredItems,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
