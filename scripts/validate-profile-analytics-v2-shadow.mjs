import fs from 'node:fs';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

loadEnvFile('.env.local');

const organizationId = process.argv[2] || '58785306-4dfb-432f-8de0-f0b33f91f3de';
const sourceClasses = ['current'];
const workerIds = ['phase-d-canary-a', 'phase-d-canary-b'];
const maxItemsPerWorker = 20;
const startedAt = Date.now();
const supabase = createClient(requiredEnv('NEXT_PUBLIC_SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { autoRefreshToken: false, persistSession: false },
});

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    if (process.env[key]) continue;
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

async function rpc(name, params) {
  const { data, error } = await supabase.rpc(name, params);
  if (error) throw error;
  return data;
}

async function main() {
  const { data: jobs, error: jobError } = await supabase
    .from('profile_analytics_refresh_jobs')
    .select('id,status,total_count,processed_count,created_at,finished_at')
    .eq('organization_id', organizationId)
    .in('status', ['completed', 'completed_with_errors'])
    .gte('total_count', 2)
    .order('created_at', { ascending: false })
    .limit(20);
  if (jobError) throw jobError;
  let job = null;
  for (const candidate of jobs ?? []) {
    const { count, error: existingError } = await supabase
      .from('profile_analytics_refresh_v2_items')
      .select('id', { count: 'exact', head: true })
      .eq('legacy_job_id', candidate.id)
      .eq('execution_mode', 'shadow')
      .eq('source_class', sourceClasses[0]);
    if (existingError) throw existingError;
    if ((count ?? 0) === 0) {
      job = candidate;
      break;
    }
  }
  if (!job) throw new Error('Nenhum job legado concluído foi encontrado para o canário.');

  const enqueue = (await rpc('enqueue_profile_analytics_refresh_v2_shadow_job', {
    p_legacy_job_id: job.id,
    p_source_classes: sourceClasses,
  }))?.[0];

  const claimedByWorker = Object.fromEntries(workerIds.map((workerId) => [workerId, 0]));
  let completed = 0;
  let claimDurationMs = 0;
  let completeDurationMs = 0;

  async function consume(workerId) {
    for (let consumed = 0; consumed < maxItemsPerWorker; consumed += 1) {
      const claimStartedAt = performance.now();
      const claimed = (await rpc('claim_profile_analytics_refresh_v2_item', {
        p_worker_id: workerId,
        p_lease_seconds: 300,
        p_max_connection_leases: 2,
        p_execution_mode: 'shadow',
      }))?.[0];
      claimDurationMs += performance.now() - claimStartedAt;
      if (!claimed) return;
      claimedByWorker[workerId] += 1;

      const completeStartedAt = performance.now();
      await rpc('complete_profile_analytics_refresh_v2_item', {
        p_item_id: claimed.item_id,
        p_worker_id: workerId,
        p_lease_token: claimed.lease_token,
        p_outcome: 'shadow_observed',
        p_retryable: false,
        p_error_class: null,
        p_error_code: null,
        p_error_message: null,
        p_duration_ms: 0,
        p_metadata: {
          canary: true,
          shadowOnly: true,
          decision: 'would_execute',
          validationScript: 'validate-profile-analytics-v2-shadow.mjs',
        },
      });
      completeDurationMs += performance.now() - completeStartedAt;
      completed += 1;
    }
  }

  await Promise.all(workerIds.map(consume));

  const { data: items, error: itemsError } = await supabase
    .from('profile_analytics_refresh_v2_items')
    .select('status,source_class,attempts,connection_key,created_at,completed_at')
    .eq('legacy_job_id', job.id)
    .eq('execution_mode', 'shadow');
  if (itemsError) throw itemsError;

  const statuses = Object.groupBy(items ?? [], (item) => item.status);
  const distinctConnections = new Set((items ?? []).map((item) => item.connection_key));
  const result = {
    measuredAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    organizationId,
    legacyJob: job,
    enqueue,
    sourceClasses,
    workers: claimedByWorker,
    collaborationObserved: Object.values(claimedByWorker).every((count) => count > 0),
    completedThisRun: completed,
    totalShadowItems: items?.length ?? 0,
    completedShadowItems: statuses.completed?.length ?? 0,
    openShadowItems: (statuses.pending?.length ?? 0) + (statuses.processing?.length ?? 0) + (statuses.retry_pending?.length ?? 0),
    deadLetterShadowItems: statuses.dead_letter?.length ?? 0,
    distinctConnections: distinctConnections.size,
    averageClaimMs: completed > 0 ? Math.round(claimDurationMs / completed) : 0,
    averageCompleteMs: completed > 0 ? Math.round(completeDurationMs / completed) : 0,
    maxItemsPerWorker,
    noAnalyticalWriteExecuted: true,
  };

  fs.writeFileSync('.profile-analytics-v2-shadow-canary-2026-08-21.json', `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
