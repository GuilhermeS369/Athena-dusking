import fs from 'node:fs';

import { createClient } from '@supabase/supabase-js';

for (const file of ['.env.local', '.env.worker.deploy', '.env.worker']) {
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2]
        .trim()
        .replace(/^["']|["']$/g, '');
    }
  }
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  throw new Error('Credenciais administrativas do Supabase ausentes.');
}

const database = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const existingJobId = process.argv[2] ?? null;

async function createCanaryJob() {
  const { data: snapshots, error: snapshotError } = await database
    .from('profile_analytics_snapshots')
    .select('profile_id,organization_id,synced_at')
    .eq('sync_status', 'synced')
    .order('synced_at', { ascending: false })
    .limit(1);
  if (snapshotError) throw snapshotError;

  const snapshot = snapshots?.[0];
  if (!snapshot) {
    throw new Error('Nenhum perfil sincronizado disponível para o canário.');
  }

  const { data, error } = await database.rpc(
    'create_profile_analytics_refresh_job',
    {
      p_organization_id: snapshot.organization_id,
      p_trigger: 'manual',
      p_profile_ids: [snapshot.profile_id],
      p_stale_after_minutes: 5,
      p_manual_cooldown_seconds: 30,
      p_force: true,
    },
  );
  if (error) throw error;

  const created = data?.[0];
  if (!created?.job_id) {
    throw new Error(`Canário não criou job: ${JSON.stringify(created ?? null)}`);
  }
  return {
    jobId: created.job_id,
    profileId: snapshot.profile_id,
    organizationId: snapshot.organization_id,
    creation: created,
  };
}

async function loadJob(jobId) {
  const { data, error } = await database
    .from('profile_analytics_refresh_jobs')
    .select('id,status,total_count,processed_count,synced_count,partial_count,no_data_count,skipped_count,failed_count,retry_pending_count,dead_letter_count,created_at,started_at,finished_at,updated_at')
    .eq('id', jobId)
    .single();
  if (error) throw error;
  return data;
}

async function loadSteps(jobId) {
  const { data, error } = await database
    .from('profile_analytics_refresh_step_events')
    .select('step,outcome,duration_ms,error_class,error_code,created_at')
    .eq('job_id', jobId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

async function loadHeartbeat() {
  const { data, error } = await database
    .from('publication_worker_heartbeats')
    .select('worker_id,status,last_seen_at,last_error_message,metadata')
    .eq('worker_kind', 'profile_analytics')
    .order('last_seen_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

const canary = existingJobId
  ? { jobId: existingJobId, profileId: null, organizationId: null, creation: null }
  : await createCanaryJob();

const deadline = Date.now() + 180_000;
let job;
while (Date.now() < deadline) {
  job = await loadJob(canary.jobId);
  if (['completed', 'partial', 'failed', 'dead_letter'].includes(job.status)) {
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 3_000));
}

const steps = await loadSteps(canary.jobId);
const forbiddenSteps = steps.filter((event) =>
  ['connection_billing', 'zernio_accounts'].includes(event.step),
);
const conflictErrors = steps.filter(
  (event) => event.error_code === '42P10' || /42P10/i.test(event.error_code ?? ''),
);
const heartbeat = await loadHeartbeat();

const report = {
  generatedAt: new Date().toISOString(),
  canary,
  job,
  heartbeat,
  validation: {
    terminal: Boolean(job && ['completed', 'partial'].includes(job.status)),
    forbiddenStepCount: forbiddenSteps.length,
    conflict42P10Count: conflictErrors.length,
    stepCount: steps.length,
  },
  steps,
};

console.log(JSON.stringify(report, null, 2));

if (!report.validation.terminal) process.exitCode = 2;
if (forbiddenSteps.length > 0 || conflictErrors.length > 0) process.exitCode = 3;
