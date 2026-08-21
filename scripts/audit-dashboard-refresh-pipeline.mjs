import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

for (const file of ['.env.local', '.env.worker.deploy', '.env.worker']) {
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Credenciais administrativas do Supabase ausentes.');

const database = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

async function allPages(table, columns, configure, pageSize = 1000) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    let query = database.from(table).select(columns);
    query = configure(query).range(from, from + pageSize - 1);
    const { data, error } = await query;
    if (error) throw error;
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < pageSize) return rows;
  }
}

const { data: organizations, error: organizationError } = await database
  .from('organizations')
  .select('id,name,slug')
  .order('name');
if (organizationError) throw organizationError;

const [jobs, steps, pressure, heartbeats, profiles, connections] = await Promise.all([
  allPages(
    'profile_analytics_refresh_jobs',
    'id,organization_id,trigger,status,total_count,processed_count,synced_count,partial_count,no_data_count,skipped_count,failed_count,retry_pending_count,dead_letter_count,created_at,started_at,finished_at,updated_at,metadata',
    (query) => query.gte('created_at', since).order('created_at', { ascending: false }),
  ),
  allPages(
    'profile_analytics_refresh_step_events',
    'job_id,organization_id,profile_id,worker_id,step,outcome,duration_ms,error_class,error_code,created_at',
    (query) => query.gte('created_at', since).order('created_at', { ascending: false }),
  ),
  allPages(
    'profile_analytics_refresh_connection_pressure_events',
    'job_id,organization_id,zernio_connection_id,connection_key,worker_id,error_class,error_code,global_concurrency,connection_concurrency,consecutive_incidents,cooldown_ms,created_at',
    (query) => query.gte('created_at', since).order('created_at', { ascending: false }),
  ),
  allPages(
    'publication_worker_heartbeats',
    'worker_id,worker_kind,status,last_seen_at,last_error_message,metadata',
    (query) => query.eq('worker_kind', 'profile_analytics').order('last_seen_at', { ascending: false }),
  ),
  allPages(
    'instagram_profiles',
    'id,organization_id,zernio_connection_id,provider,status,deleted_at',
    (query) => query.eq('provider', 'zernio').is('deleted_at', null),
  ),
  allPages(
    'zernio_connections',
    'id,organization_id,label,status,deleted_at',
    (query) => query.is('deleted_at', null),
  ),
]);

function percentile(values, percentileValue) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1)];
}

function durationsSummary(values) {
  return {
    count: values.length,
    totalMs: values.reduce((sum, value) => sum + value, 0),
    avgMs: values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null,
    p50Ms: percentile(values, 50),
    p95Ms: percentile(values, 95),
    maxMs: values.length ? Math.max(...values) : null,
  };
}

function summarizeSteps(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = `${row.step}:${row.outcome}`;
    const current = grouped.get(key) ?? { step: row.step, outcome: row.outcome, durations: [], errors: {} };
    current.durations.push(Number(row.duration_ms) || 0);
    if (row.error_class || row.error_code) {
      const errorKey = `${row.error_class ?? 'none'}:${row.error_code ?? 'none'}`;
      current.errors[errorKey] = (current.errors[errorKey] ?? 0) + 1;
    }
    grouped.set(key, current);
  }
  return [...grouped.values()]
    .map(({ step, outcome, durations, errors }) => ({ step, outcome, ...durationsSummary(durations), errors }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

function jobDuration(job) {
  if (!job.started_at) return null;
  return Date.parse(job.finished_at ?? job.updated_at) - Date.parse(job.started_at);
}

const organizationById = new Map((organizations ?? []).map((organization) => [organization.id, organization]));
const report = {
  generatedAt: new Date().toISOString(),
  since,
  totals: {
    organizations: organizations?.length ?? 0,
    profiles: profiles.length,
    connections: connections.length,
    jobs: jobs.length,
    steps: steps.length,
    pressureEvents: pressure.length,
    heartbeats: heartbeats.length,
  },
  workers: heartbeats,
  organizations: (organizations ?? []).map((organization) => {
    const organizationJobs = jobs.filter((job) => job.organization_id === organization.id);
    const organizationSteps = steps.filter((step) => step.organization_id === organization.id);
    const organizationProfiles = profiles.filter((profile) => profile.organization_id === organization.id);
    const organizationConnections = connections.filter((connection) => connection.organization_id === organization.id);
    const profileCounts = new Map();
    for (const profile of organizationProfiles) {
      const key = profile.zernio_connection_id ?? 'organization-default';
      profileCounts.set(key, (profileCounts.get(key) ?? 0) + 1);
    }
    const durations = organizationJobs.map(jobDuration).filter((value) => Number.isFinite(value) && value >= 0);
    return {
      ...organization,
      profiles: organizationProfiles.length,
      connections: organizationConnections.length,
      profilesPerConnection: [...profileCounts.entries()]
        .map(([connectionId, total]) => ({ connectionId, label: organizationConnections.find((connection) => connection.id === connectionId)?.label ?? null, total }))
        .sort((a, b) => b.total - a.total),
      jobs: {
        count: organizationJobs.length,
        byTrigger: organizationJobs.reduce((result, job) => ({ ...result, [job.trigger]: (result[job.trigger] ?? 0) + 1 }), {}),
        byStatus: organizationJobs.reduce((result, job) => ({ ...result, [job.status]: (result[job.status] ?? 0) + 1 }), {}),
        durations: durationsSummary(durations),
        requestedItems: organizationJobs.reduce((sum, job) => sum + job.total_count, 0),
        processedItems: organizationJobs.reduce((sum, job) => sum + job.processed_count, 0),
        failedItems: organizationJobs.reduce((sum, job) => sum + job.failed_count, 0),
        recent: organizationJobs.slice(0, 20).map((job) => ({ ...job, durationMs: jobDuration(job) })),
      },
      steps: summarizeSteps(organizationSteps),
      pressure: pressure.filter((event) => event.organization_id === organization.id),
    };
  }),
  unknownOrganizationJobs: jobs.filter((job) => !organizationById.has(job.organization_id)).length,
};

console.log(JSON.stringify(report, null, 2));
