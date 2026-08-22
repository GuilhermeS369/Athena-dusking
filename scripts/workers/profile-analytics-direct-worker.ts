#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
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

const once = process.argv.includes('--once');
const workerId = process.env.PROFILE_ANALYTICS_DIRECT_WORKER_ID
  || `athena-vps-profile-analytics-direct-${os.hostname()}-${process.pid}`;
const enabled = booleanEnv('PROFILE_ANALYTICS_DIRECT_ENABLED', false);
const organizationIds = csvEnv('PROFILE_ANALYTICS_DIRECT_ORGANIZATION_IDS');
const pollMs = integerEnv('PROFILE_ANALYTICS_DIRECT_POLL_INTERVAL_MS', 10_000, 1_000, 300_000);
const heartbeatIntervalMs = integerEnv('PROFILE_ANALYTICS_DIRECT_HEARTBEAT_INTERVAL_MS', 30_000, 5_000, 300_000);
const limit = integerEnv('PROFILE_ANALYTICS_DIRECT_LIMIT', 1, 1, 50);
const concurrency = integerEnv('PROFILE_ANALYTICS_DIRECT_CONCURRENCY', 1, 1, 10);
const leaseSeconds = integerEnv('PROFILE_ANALYTICS_DIRECT_LEASE_SECONDS', 300, 30, 1800);
const v2LiveCurrentEnabled = booleanEnv('PROFILE_ANALYTICS_QUEUE_V2_LIVE_CURRENT_ENABLED', false);
const v2LiveCurrentOrganizationIds = csvEnv('PROFILE_ANALYTICS_QUEUE_V2_LIVE_CURRENT_ORGANIZATION_IDS');
const v2LiveCurrentLimit = integerEnv('PROFILE_ANALYTICS_QUEUE_V2_LIVE_CURRENT_LIMIT', 1, 1, 10);
const v2LiveCurrentConcurrency = integerEnv('PROFILE_ANALYTICS_QUEUE_V2_LIVE_CURRENT_CONCURRENCY', 1, 1, 5);
const v2LiveDailyEnabled = booleanEnv('PROFILE_ANALYTICS_QUEUE_V2_LIVE_DAILY_ENABLED', false);
const v2LiveDailyOrganizationIds = csvEnv('PROFILE_ANALYTICS_QUEUE_V2_LIVE_DAILY_ORGANIZATION_IDS');
const v2LiveDailyLimit = integerEnv('PROFILE_ANALYTICS_QUEUE_V2_LIVE_DAILY_LIMIT', 1, 1, 10);
const v2LiveDailyConcurrency = integerEnv('PROFILE_ANALYTICS_QUEUE_V2_LIVE_DAILY_CONCURRENCY', 1, 1, 5);
const v2LivePostsEnabled = booleanEnv('PROFILE_ANALYTICS_QUEUE_V2_LIVE_POSTS_ENABLED', false);
const v2LivePostsOrganizationIds = csvEnv('PROFILE_ANALYTICS_QUEUE_V2_LIVE_POSTS_ORGANIZATION_IDS');
const v2LivePostsLimit = integerEnv('PROFILE_ANALYTICS_QUEUE_V2_LIVE_POSTS_LIMIT', 1, 1, 10);
const v2LivePostsConcurrency = integerEnv('PROFILE_ANALYTICS_QUEUE_V2_LIVE_POSTS_CONCURRENCY', 1, 1, 5);

if (enabled && organizationIds.length === 0) {
  throw new Error('PROFILE_ANALYTICS_DIRECT_ORGANIZATION_IDS é obrigatório quando o executor direto está habilitado.');
}

const supabase = createClient(requiredEnv('NEXT_PUBLIC_SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { autoRefreshToken: false, persistSession: false },
});

let stopping = false;
let lastHeartbeatAt = 0;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

function booleanEnv(name: string, fallback: boolean) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return value === 'true' || value === '1' || value === 'yes';
}

function integerEnv(name: string, fallback: number, minimum: number, maximum: number) {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

function csvEnv(name: string) {
  return [...new Set((process.env[name] ?? '').split(',').map((value) => value.trim()).filter(Boolean))];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function heartbeat(status: string, metadata: Record<string, unknown> = {}, lastErrorMessage: string | null = null) {
  const { error } = await supabase.rpc('upsert_publication_worker_heartbeat', {
    p_worker_id: workerId,
    p_worker_kind: 'profile_analytics',
    p_status: status,
    p_dry_run: !enabled,
    p_version: process.env.npm_package_version || null,
    p_hostname: os.hostname(),
    p_process_id: process.pid,
    p_last_error_message: lastErrorMessage,
    p_metadata: {
      executionMode: enabled ? 'direct' : 'observe',
      once,
      organizationIds,
      pollMs,
      heartbeatIntervalMs,
      limit,
      concurrency,
      leaseSeconds,
      v2LiveCurrentEnabled,
      v2LiveCurrentOrganizationIds,
      v2LiveDailyEnabled,
      v2LiveDailyOrganizationIds,
      v2LivePostsEnabled,
      v2LivePostsOrganizationIds,
      ...metadata,
    },
  });
  if (error) throw error;
  lastHeartbeatAt = Date.now();
}

async function tick() {
  if (!enabled) return { observed: true, chunks: 0, hasMore: false };

  // O import acontece somente no modo direto. Assim, o canário observe valida
  // ambiente e heartbeat sem carregar o executor nem tocar a fila.
  const { dispatchProfileAnalyticsRefreshJobs, dispatchProfileAnalyticsV2LiveItems } = await import('../../lib/integrations/profile-analytics-refresh-worker.ts');
  const legacy = await dispatchProfileAnalyticsRefreshJobs({
    workerId,
    organizationIds,
    limit,
    concurrency,
    leaseSeconds,
    shadowEnabled: false,
  });
  const liveCurrent = v2LiveCurrentEnabled
    ? await dispatchProfileAnalyticsV2LiveItems({
      workerId: `${workerId}-v2-current`,
      organizationIds: v2LiveCurrentOrganizationIds,
      sourceClasses: ['current'],
      limit: v2LiveCurrentLimit,
      concurrency: v2LiveCurrentConcurrency,
      leaseSeconds,
      maxConnectionLeases: 1,
    })
    : { enabled: false, claimed: 0, completed: 0, failed: 0, hasMore: false, sourceClasses: ['current'] as const };
  const liveDaily = v2LiveDailyEnabled
    ? await dispatchProfileAnalyticsV2LiveItems({
      workerId: `${workerId}-v2-daily`,
      organizationIds: v2LiveDailyOrganizationIds,
      sourceClasses: ['daily'],
      limit: v2LiveDailyLimit,
      concurrency: v2LiveDailyConcurrency,
      leaseSeconds,
      maxConnectionLeases: 1,
    })
    : { enabled: false, claimed: 0, completed: 0, failed: 0, hasMore: false, sourceClasses: ['daily'] as const };
  const livePosts = v2LivePostsEnabled
    ? await dispatchProfileAnalyticsV2LiveItems({
      workerId: `${workerId}-v2-posts`,
      organizationIds: v2LivePostsOrganizationIds,
      sourceClasses: ['posts'],
      limit: v2LivePostsLimit,
      concurrency: v2LivePostsConcurrency,
      leaseSeconds,
      maxConnectionLeases: 1,
    })
    : { enabled: false, claimed: 0, completed: 0, failed: 0, hasMore: false, sourceClasses: ['posts'] as const };
  return {
    ...legacy,
    liveCurrent,
    liveDaily,
    livePosts,
    hasMore: legacy.hasMore || liveCurrent.hasMore || liveDaily.hasMore || livePosts.hasMore,
  };
}

async function main() {
  console.info('[profile-analytics-direct-worker] iniciando', {
    workerId,
    enabled,
    once,
    organizationIds,
    limit,
    concurrency,
  });
  await heartbeat('starting');

  while (!stopping) {
    try {
      const payload = await tick();
      const status = Number(payload?.chunks ?? 0) > 0 ? 'processing' : 'idle';
      if (Date.now() - lastHeartbeatAt >= heartbeatIntervalMs || once) {
        await heartbeat(status, { payload });
      }
      console.info('[profile-analytics-direct-worker] ciclo concluído', payload);
      if (once) break;
      if (payload?.hasMore !== true) await sleep(pollMs);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      console.error('[profile-analytics-direct-worker] falha no ciclo', caught);
      await heartbeat('error', {}, message).catch((error) => {
        console.error('[profile-analytics-direct-worker] falha ao registrar heartbeat de erro', error);
      });
      if (once) throw caught;
      await sleep(pollMs);
    }
  }

  await heartbeat('stopped').catch((error) => {
    console.error('[profile-analytics-direct-worker] falha ao registrar parada', error);
  });
  console.info('[profile-analytics-direct-worker] finalizado', { workerId });
}

main().catch((error) => {
  console.error('[profile-analytics-direct-worker] erro fatal', error);
  process.exitCode = 1;
});
