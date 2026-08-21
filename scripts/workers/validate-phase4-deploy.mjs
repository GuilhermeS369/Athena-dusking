#!/usr/bin/env node

import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

loadEnvFile('.env.local');
loadEnvFile('.env.worker');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    if (process.env[key]) continue;
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

const supabase = createClient(requiredEnv('NEXT_PUBLIC_SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  const [settingsResult, reservationsResult, heartbeatsResult, generationJobsResult] = await Promise.all([
    supabase
      .from('publication_rate_limit_settings')
      .select('id, organization_id, provider, enabled, max_provider_publications_per_minute, max_profile_publications_per_24h, min_seconds_between_profile_publications, reservation_seconds')
      .limit(10),
    supabase
      .from('publication_dispatch_rate_reservations')
      .select('publication_item_id', { count: 'exact', head: true }),
    supabase
      .from('publication_worker_heartbeats')
      .select('worker_id, worker_kind, status, dry_run, last_seen_at, last_error_message, metadata')
      .in('worker_id', ['athena-vps-publication-1', 'athena-vps-generation-1'])
      .order('worker_id'),
    supabase
      .from('publication_generation_jobs')
      .select('id', { count: 'exact', head: true })
      .in('status', ['queued', 'processing']),
  ]);

  for (const result of [settingsResult, reservationsResult, heartbeatsResult, generationJobsResult]) {
    if (result.error) throw result.error;
  }

  console.log(JSON.stringify({
    rateLimitSettings: settingsResult.data ?? [],
    activeDispatchReservations: reservationsResult.count ?? 0,
    activeGenerationJobs: generationJobsResult.count ?? 0,
    heartbeats: heartbeatsResult.data ?? [],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
