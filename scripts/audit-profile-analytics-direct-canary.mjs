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

const supabase = createClient(
  requiredEnv('NEXT_PUBLIC_SUPABASE_URL'),
  requiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const organizationIds = (process.env.PROFILE_ANALYTICS_DIRECT_ORGANIZATION_IDS ?? '')
  .split(',').map((value) => value.trim()).filter(Boolean);
const workerId = process.env.PROFILE_ANALYTICS_DIRECT_WORKER_ID
  ?? 'athena-vps-profile-analytics-direct-1';
const auditJobId = process.env.PROFILE_ANALYTICS_AUDIT_JOB_ID?.trim() || null;
const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

async function rows(query, label) {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data ?? [];
}

async function pagedRows(queryForRange, label, pageSize = 1000) {
  const result = [];
  for (let from = 0; ; from += pageSize) {
    const page = await rows(queryForRange(from, from + pageSize - 1), label);
    result.push(...page);
    if (page.length < pageSize) return result;
  }
}

function countsBy(values) {
  const counts = new Map();
  for (const value of values) {
    const key = value || 'unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

const heartbeats = await rows(
  supabase.from('publication_worker_heartbeats')
    .select('worker_id,status,dry_run,last_seen_at,last_error_message,metadata')
    .eq('worker_id', workerId),
  'heartbeat',
);

let jobsQuery = supabase.from('profile_analytics_refresh_jobs')
    .select('id,organization_id,trigger,status,total_count,processed_count,synced_count,partial_count,no_data_count,skipped_count,failed_count,retry_pending_count,dead_letter_count,created_at,started_at,finished_at,claimed_by,lease_until,last_error_message')
    .in('organization_id', organizationIds)
    .gte('created_at', since);
if (auditJobId) jobsQuery = jobsQuery.eq('id', auditJobId);
jobsQuery = jobsQuery.order('created_at', { ascending: false }).limit(auditJobId ? 1 : 30);

const jobs = organizationIds.length === 0 ? [] : await rows(
  jobsQuery,
  'jobs',
);

const auditedJobs = [];
for (const job of jobs) {
  const items = await rows(
    supabase.from('profile_analytics_refresh_job_items')
      .select('profile_id,status,attempts,max_attempts,claimed_by,lease_until,last_error_class,last_error_code,last_attempt_at,processed_at')
      .eq('job_id', job.id),
    `items ${job.id}`,
  );
  const itemEvents = await pagedRows(
    (from, to) => supabase.from('profile_analytics_refresh_item_events')
      .select('profile_id,event_type,attempt_number,worker_id,error_class,error_code,error_message,next_attempt_at,metadata,created_at')
      .eq('job_id', job.id)
      .order('created_at', { ascending: true })
      .range(from, to),
    `item events ${job.id}`,
  );
  const stepEvents = await pagedRows(
    (from, to) => supabase.from('profile_analytics_refresh_step_events')
      .select('profile_id,worker_id,step,outcome,duration_ms,error_class,error_code,created_at')
      .eq('job_id', job.id)
      .order('created_at', { ascending: true })
      .range(from, to),
    `step events ${job.id}`,
  );
  const claimEvents = itemEvents.filter((event) => ['claimed', 'lease_recovered'].includes(event.event_type));
  const directWorkerEvents = itemEvents.filter((event) => event.worker_id === workerId);
  const directWorkerProfileIds = unique(directWorkerEvents.map((event) => event.profile_id));
  const claimsByProfile = new Map();
  for (const event of claimEvents) {
    const profileClaims = claimsByProfile.get(event.profile_id) ?? [];
    profileClaims.push(event);
    claimsByProfile.set(event.profile_id, profileClaims);
  }
  const multipleClaimProfiles = [...claimsByProfile.entries()]
    .filter(([, events]) => events.length > 1)
    .map(([profileId, events]) => ({
      profileId,
      claims: events.length,
      attempts: unique(events.map((event) => String(event.attempt_number))),
      workers: unique(events.map((event) => event.worker_id)),
      leaseRecoveries: events.filter((event) => event.event_type === 'lease_recovered').length,
    }));
  const crossWorkerClaimProfiles = multipleClaimProfiles.filter((entry) => entry.workers.length > 1);
  const deadLetters = itemEvents
    .filter((event) => event.event_type === 'dead_lettered')
    .map((event) => ({
      profileId: event.profile_id,
      attempt: event.attempt_number,
      workerId: event.worker_id,
      errorClass: event.error_class,
      errorCode: event.error_code,
      errorMessage: event.error_message,
      createdAt: event.created_at,
    }));
  const errorSteps = stepEvents.filter((event) => event.outcome === 'error');
  const pressureLikeSteps = errorSteps.filter((event) => {
    const signature = `${event.error_class ?? ''} ${event.error_code ?? ''}`.toLowerCase();
    return /timeout|rate|(^|\D)429(\D|$)|(^|\D)5\d\d(\D|$)|network|fetch/.test(signature);
  });
  const statuses = countsBy(items.map((item) => item.status));
  const attempts = items.map((item) => Number(item.attempts ?? 0));
  const durationSeconds = job.started_at && job.finished_at
    ? Math.round((Date.parse(job.finished_at) - Date.parse(job.started_at)) / 100) / 10
    : null;
  auditedJobs.push({
    ...job,
    durationSeconds,
    itemCount: items.length,
    statuses,
    maxAttempts: attempts.length ? Math.max(...attempts) : 0,
    retryItems: items.filter((item) => Number(item.attempts ?? 0) > 1).length,
    openItems: items.filter((item) => ['pending', 'processing', 'retry_pending'].includes(item.status)).length,
    expiredLeases: items.filter((item) => item.status === 'processing' && item.lease_until && Date.parse(item.lease_until) <= Date.now()).length,
    attribution: {
      itemEvents: itemEvents.length,
      claimEvents: claimEvents.length,
      terminalEvents: itemEvents.filter((event) => ['synced', 'partial', 'no_data', 'skipped', 'dead_lettered'].includes(event.event_type)).length,
      workers: unique(itemEvents.map((event) => event.worker_id)),
      directWorkerEvents: directWorkerEvents.length,
      directWorkerProfiles: directWorkerProfileIds.length,
      directWorkerClaimEvents: claimEvents.filter((event) => event.worker_id === workerId).length,
      leaseRecoveries: claimEvents.filter((event) => event.event_type === 'lease_recovered').length,
      multipleClaimProfiles,
      crossWorkerClaimProfiles,
    },
    deadLetters,
    telemetry: {
      stepEvents: stepEvents.length,
      directWorkerStepEvents: stepEvents.filter((event) => event.worker_id === workerId).length,
      workers: unique(stepEvents.map((event) => event.worker_id)),
      outcomes: countsBy(stepEvents.map((event) => event.outcome)),
      errorsByStep: countsBy(errorSteps.map((event) => event.step)),
      errorsByClass: countsBy(errorSteps.map((event) => event.error_class)),
      errorsByCode: countsBy(errorSteps.map((event) => event.error_code)),
      pressureLikeErrors: pressureLikeSteps.length,
    },
  });
}

const pressureEvents = organizationIds.length === 0 ? [] : await rows(
  supabase.from('profile_analytics_refresh_connection_pressure_events')
    .select('organization_id,job_id,error_class,error_code,cooldown_ms,created_at')
    .in('organization_id', organizationIds)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1000),
  'pressure events',
);

const report = {
  measuredAt: new Date().toISOString(),
  since,
  workerId,
  auditJobId,
  organizationIds,
  heartbeats,
  totals: {
    jobs: auditedJobs.length,
    completedJobs: auditedJobs.filter((job) => ['completed', 'completed_with_errors'].includes(job.status)).length,
    directWorkerItems: auditedJobs.reduce((sum, job) => sum + job.attribution.directWorkerProfiles, 0),
    directWorkerClaimEvents: auditedJobs.reduce((sum, job) => sum + job.attribution.directWorkerClaimEvents, 0),
    leaseRecoveries: auditedJobs.reduce((sum, job) => sum + job.attribution.leaseRecoveries, 0),
    multipleClaimProfiles: auditedJobs.reduce((sum, job) => sum + job.attribution.multipleClaimProfiles.length, 0),
    crossWorkerClaimProfiles: auditedJobs.reduce((sum, job) => sum + job.attribution.crossWorkerClaimProfiles.length, 0),
    retries: auditedJobs.reduce((sum, job) => sum + job.retryItems, 0),
    openItems: auditedJobs.reduce((sum, job) => sum + job.openItems, 0),
    expiredLeases: auditedJobs.reduce((sum, job) => sum + job.expiredLeases, 0),
    deadLetters: auditedJobs.reduce((sum, job) => sum + Number(job.dead_letter_count ?? 0), 0),
    pressureEvents: pressureEvents.length,
  },
  pressureEvents,
  jobs: auditedJobs,
};

console.log(JSON.stringify(report, null, 2));
