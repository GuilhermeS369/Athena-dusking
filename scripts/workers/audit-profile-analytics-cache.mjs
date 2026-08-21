#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

function loadEnvironment() {
  const values = { ...process.env };
  for (const file of ['.env.worker.deploy', '.env.worker', '.env.local']) {
    if (!existsSync(file)) continue;
    for (const source of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = source.trim();
      const separator = line.indexOf('=');
      if (!line || line.startsWith('#') || separator < 1) continue;
      const key = line.slice(0, separator).trim();
      if (!values[key]) values[key] = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return values;
}

function saoPauloDateKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const value = (type) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function dailyRows(snapshot) {
  const raw = snapshot?.raw_payload;
  const rows = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.dailyMetrics?.dailyData : [];
  return Array.isArray(rows) ? rows.filter((row) => row && typeof row === 'object' && typeof row.date === 'string') : [];
}

const env = loadEnvironment();
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não está configurada.');

const organizationId = process.env.ANALYTICS_AUDIT_ORGANIZATION_ID ?? null;
const output = process.env.ANALYTICS_AUDIT_OUTPUT ?? `analytics-cache-audit-${saoPauloDateKey()}.json`;
const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const today = saoPauloDateKey();
let profilesQuery = supabase.from('instagram_profiles').select('id, organization_id, username, provider, status, zernio_account_id').is('deleted_at', null).order('organization_id').order('username').limit(5000);
if (organizationId) profilesQuery = profilesQuery.eq('organization_id', organizationId);
const { data: profiles, error: profilesError } = await profilesQuery;
if (profilesError) throw profilesError;

const profileIds = (profiles ?? []).map((profile) => profile.id);
const snapshotsResult = profileIds.length
  ? await supabase.from('profile_analytics_snapshots').select('profile_id, period_start, period_end, sync_status, synced_at, reach, views, total_interactions, posts_count, raw_payload').in('profile_id', profileIds).is('deleted_at', null).order('synced_at', { ascending: false }).limit(10000)
  : { data: [], error: null };
if (snapshotsResult.error) throw snapshotsResult.error;

let jobsQuery = supabase.from('profile_analytics_refresh_jobs')
  .select('id, organization_id, status, trigger, total_count, processed_count, synced_count, partial_count, no_data_count, failed_count, retry_pending_count, dead_letter_count, created_at, started_at, finished_at, updated_at')
  .order('created_at', { ascending: false })
  .limit(100);
if (organizationId) jobsQuery = jobsQuery.eq('organization_id', organizationId);
const { data: jobs, error: jobsError } = await jobsQuery;
if (jobsError) throw jobsError;

const latestSnapshots = new Map();
for (const snapshot of snapshotsResult.data ?? []) {
  const current = latestSnapshots.get(snapshot.profile_id);
  if (!current || `${snapshot.synced_at ?? ''}|${snapshot.period_end}` > `${current.synced_at ?? ''}|${current.period_end}`) latestSnapshots.set(snapshot.profile_id, snapshot);
}

const profileAudit = (profiles ?? []).map((profile) => {
  const snapshot = latestSnapshots.get(profile.id);
  const daily = dailyRows(snapshot);
  const dates = [...new Set(daily.map((row) => row.date.slice(0, 10)))].sort();
  const todayRow = daily.find((row) => row.date.slice(0, 10) === today) ?? null;
  const findings = [
    !snapshot && 'missing_snapshot',
    snapshot && !['synced', 'partial'].includes(snapshot.sync_status) && `snapshot_status_${snapshot.sync_status}`,
    snapshot && daily.length === 0 && 'missing_daily_payload',
    daily.length > dates.length && 'duplicate_daily_dates',
    snapshot && daily.length > 0 && !todayRow && 'today_not_cached',
  ].filter(Boolean);
  return {
    profileId: profile.id,
    organizationId: profile.organization_id,
    username: profile.username,
    provider: profile.provider,
    profileStatus: profile.status,
    hasZernioAccount: Boolean(profile.zernio_account_id),
    latestSnapshot: snapshot ? {
      periodStart: snapshot.period_start,
      periodEnd: snapshot.period_end,
      syncedAt: snapshot.synced_at,
      syncStatus: snapshot.sync_status,
      totals: { reach: snapshot.reach, views: snapshot.views, interactions: snapshot.total_interactions, posts: snapshot.posts_count },
      error: snapshot.raw_payload && typeof snapshot.raw_payload === 'object' && !Array.isArray(snapshot.raw_payload)
        ? snapshot.raw_payload.error ?? null
        : null,
    } : null,
    dailyPayload: {
      rows: daily.length,
      uniqueDates: dates.length,
      firstDate: dates[0] ?? null,
      lastDate: dates.at(-1) ?? null,
      hasToday: Boolean(todayRow),
      todayPostCount: todayRow?.postCount ?? null,
      todayMetricKeys: todayRow?.metrics && typeof todayRow.metrics === 'object' ? Object.keys(todayRow.metrics) : [],
    },
    findings,
  };
});

const snapshotStatuses = Object.fromEntries([...latestSnapshots.values()].reduce((totals, snapshot) => {
  totals.set(snapshot.sync_status, (totals.get(snapshot.sync_status) ?? 0) + 1);
  return totals;
}, new Map()));
const findings = Object.fromEntries(profileAudit.flatMap((profile) => profile.findings).reduce((totals, finding) => {
  totals.set(finding, (totals.get(finding) ?? 0) + 1);
  return totals;
}, new Map()));

const report = {
  generatedAt: new Date().toISOString(),
  organizationId,
  todaySaoPaulo: today,
  totals: {
    profiles: profileAudit.length,
    snapshots: latestSnapshots.size,
    profilesWithToday: profileAudit.filter((profile) => profile.dailyPayload.hasToday).length,
    profilesWithFindings: profileAudit.filter((profile) => profile.findings.length > 0).length,
    snapshotStatuses,
    findings,
    jobStatuses: Object.fromEntries((jobs ?? []).reduce((totals, job) => {
      totals.set(job.status, (totals.get(job.status) ?? 0) + 1);
      return totals;
    }, new Map())),
  },
  jobs,
  profiles: profileAudit,
};
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.info(JSON.stringify({ output, ...report.totals, todaySaoPaulo: today }, null, 2));
