import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

function localWorkerEnvironment() {
  try {
    return Object.fromEntries(readFileSync('.env.worker.deploy', 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator).trim(), line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '')];
      }));
  } catch {
    return {};
  }
}

const env = { ...localWorkerEnvironment(), ...process.env };
const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) throw new Error('Credenciais administrativas do Supabase ausentes.');

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const workerA = `analytics-canary-a-${randomUUID()}`.slice(0, 120);
const workerB = `analytics-canary-b-${randomUUID()}`.slice(0, 120);
let jobId = null;

async function rpc(name, parameters) {
  const { data, error } = await supabase.rpc(name, parameters);
  if (error) throw error;
  return data;
}

try {
  const { data: profiles, error: profileError } = await supabase
    .from('instagram_profiles')
    .select('id, organization_id, zernio_connection_id')
    .eq('provider', 'zernio')
    .is('deleted_at', null)
    .not('zernio_account_id', 'is', null)
    .limit(50);
  if (profileError) throw profileError;

  let selected = null;
  for (const profile of profiles ?? []) {
    const { count, error } = await supabase
      .from('profile_analytics_refresh_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', profile.organization_id)
      .in('status', ['pending', 'processing']);
    if (error) throw error;
    if ((count ?? 0) === 0) {
      selected = profile;
      break;
    }
  }
  if (!selected) throw new Error('Nenhuma organização sem job ativo disponível para o canário.');

  const { data: job, error: jobError } = await supabase
    .from('profile_analytics_refresh_jobs')
    .insert({
      organization_id: selected.organization_id,
      trigger: 'worker',
      status: 'pending',
      total_count: 1,
      metadata: { canary: 'analytics_resilience_2026_08_16' },
    })
    .select('id')
    .single();
  if (jobError) throw jobError;
  jobId = job.id;

  const { error: itemError } = await supabase
    .from('profile_analytics_refresh_job_items')
    .insert({
      job_id: jobId,
      organization_id: selected.organization_id,
      profile_id: selected.id,
      zernio_connection_id: selected.zernio_connection_id,
      max_attempts: 3,
    });
  if (itemError) throw itemError;

  const firstJobClaim = await rpc('claim_profile_analytics_refresh_job', { p_worker_id: workerA, p_lease_seconds: 30 });
  const firstItemClaim = await rpc('claim_profile_analytics_refresh_job_item', { p_job_id: jobId, p_worker_id: workerA, p_lease_seconds: 30 });
  if (firstJobClaim?.[0]?.job_id !== jobId || firstItemClaim?.[0]?.attempts !== 1) throw new Error('Primeiro claim atômico não entregou o canário esperado.');

  const expiredAt = new Date(Date.now() - 60_000).toISOString();
  const { error: expireItemError } = await supabase
    .from('profile_analytics_refresh_job_items')
    .update({ lease_until: expiredAt })
    .eq('job_id', jobId)
    .eq('profile_id', selected.id);
  if (expireItemError) throw expireItemError;
  const { error: expireJobError } = await supabase
    .from('profile_analytics_refresh_jobs')
    .update({ lease_until: expiredAt })
    .eq('id', jobId);
  if (expireJobError) throw expireJobError;

  const recoveredJobClaim = await rpc('claim_profile_analytics_refresh_job', { p_worker_id: workerB, p_lease_seconds: 30 });
  const recoveredItemClaim = await rpc('claim_profile_analytics_refresh_job_item', { p_job_id: jobId, p_worker_id: workerB, p_lease_seconds: 30 });
  if (recoveredJobClaim?.[0]?.job_id !== jobId || recoveredItemClaim?.[0]?.attempts !== 2) throw new Error('Recuperação de lease expirado não incrementou a segunda tentativa.');

  const retryResult = await rpc('complete_profile_analytics_refresh_job_item', {
    p_job_id: jobId,
    p_profile_id: selected.id,
    p_worker_id: workerB,
    p_outcome: 'error',
    p_error_class: 'timeout',
    p_error_code: 'CANARY_TIMEOUT',
    p_error_message: 'Timeout sintético controlado.',
    p_retryable: true,
    p_metadata: { canary: true },
  });
  if (retryResult?.[0]?.status !== 'retry_pending' || !retryResult?.[0]?.next_attempt_at) throw new Error('Falha retryable não recebeu backoff persistido.');

  const { data: prematureClaim } = await supabase.rpc('claim_profile_analytics_refresh_job', { p_worker_id: workerB, p_lease_seconds: 30 });
  if ((prematureClaim ?? []).some((row) => row.job_id === jobId)) throw new Error('Job foi entregue antes do vencimento do backoff.');

  const { error: dueError } = await supabase
    .from('profile_analytics_refresh_job_items')
    .update({ next_attempt_at: expiredAt })
    .eq('job_id', jobId)
    .eq('profile_id', selected.id);
  if (dueError) throw dueError;

  const finalJobClaim = await rpc('claim_profile_analytics_refresh_job', { p_worker_id: workerB, p_lease_seconds: 30 });
  const finalItemClaim = await rpc('claim_profile_analytics_refresh_job_item', { p_job_id: jobId, p_worker_id: workerB, p_lease_seconds: 30 });
  if (finalJobClaim?.[0]?.job_id !== jobId || finalItemClaim?.[0]?.attempts !== 3) throw new Error('Retry vencido não foi reivindicado na terceira tentativa.');

  const deadLetterResult = await rpc('complete_profile_analytics_refresh_job_item', {
    p_job_id: jobId,
    p_profile_id: selected.id,
    p_worker_id: workerB,
    p_outcome: 'error',
    p_error_class: 'timeout',
    p_error_code: 'CANARY_TIMEOUT_EXHAUSTED',
    p_error_message: 'Timeout sintético após máximo de tentativas.',
    p_retryable: true,
    p_metadata: { canary: true },
  });
  if (deadLetterResult?.[0]?.status !== 'dead_letter' || deadLetterResult?.[0]?.dead_lettered !== true) throw new Error('Esgotamento não terminou em dead-letter.');

  const { data: events, error: eventError } = await supabase
    .from('profile_analytics_refresh_item_events')
    .select('event_type, attempt_number')
    .eq('job_id', jobId)
    .order('id');
  if (eventError) throw eventError;

  const sequence = (events ?? []).map((event) => `${event.event_type}:${event.attempt_number}`);
  const expected = ['claimed:1', 'lease_recovered:2', 'retry_scheduled:2', 'claimed:3', 'dead_lettered:3'];
  if (JSON.stringify(sequence) !== JSON.stringify(expected)) throw new Error(`Ledger divergente: ${sequence.join(', ')}`);

  console.info(JSON.stringify({
    validated: true,
    jobId,
    profileId: selected.id,
    leaseRecoveryAttempt: recoveredItemClaim[0].attempts,
    retryStatus: retryResult[0].status,
    retryAt: retryResult[0].next_attempt_at,
    prematureClaimBlocked: true,
    terminalStatus: deadLetterResult[0].status,
    events: sequence,
  }, null, 2));
} finally {
  if (jobId) {
    const { error } = await supabase.from('profile_analytics_refresh_jobs').delete().eq('id', jobId);
    if (error) console.error('Falha ao limpar job sintético de analytics.', { jobId, code: error.code });
  }
}
