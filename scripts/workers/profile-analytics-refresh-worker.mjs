#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

loadEnvFile('.env.local');
loadEnvFile('.env.worker');

const args = new Set(process.argv.slice(2));
const runOnce = args.has('--once') || process.env.PROFILE_ANALYTICS_REFRESH_WORKER_ONCE === 'true';
const workerId = process.env.PROFILE_ANALYTICS_REFRESH_WORKER_ID || `profile-analytics-${os.hostname()}-${process.pid}`;
const appBaseUrl = requiredEnv('PUBLICATION_WORKER_APP_BASE_URL').replace(/\/$/, '');
const workerSecret = process.env.PROFILE_ANALYTICS_REFRESH_WORKER_SECRET || process.env.PUBLICATION_WORKER_SECRET || process.env.CRON_SECRET;
const pollIntervalMs = integerEnv('PROFILE_ANALYTICS_REFRESH_WORKER_POLL_INTERVAL_MS', 10000, 1000, 300000);
const heartbeatIntervalMs = integerEnv('PROFILE_ANALYTICS_REFRESH_WORKER_HEARTBEAT_INTERVAL_MS', 30000, 5000, 300000);
const limit = integerEnv('PROFILE_ANALYTICS_REFRESH_WORKER_LIMIT', 20, 1, 50);
const concurrency = integerEnv('PROFILE_ANALYTICS_REFRESH_WORKER_CONCURRENCY', 10, 1, 10);
const leaseSeconds = integerEnv('PROFILE_ANALYTICS_REFRESH_WORKER_LEASE_SECONDS', 300, 30, 1800);

let stopping = false;
let lastHeartbeatAt = 0;
let lastTickHasMore = false;

process.on('SIGINT', () => {
  stopping = true;
});
process.on('SIGTERM', () => {
  stopping = true;
});

function integerEnv(name, fallback, minimum, maximum) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSupabase() {
  return createClient(requiredEnv('NEXT_PUBLIC_SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function heartbeat(supabase, status, metadata = {}, lastErrorMessage = null) {
  const { error } = await supabase.rpc('upsert_publication_worker_heartbeat', {
    p_worker_id: workerId,
    p_worker_kind: 'profile_analytics',
    p_status: status,
    p_dry_run: false,
    p_version: process.env.npm_package_version || null,
    p_hostname: os.hostname(),
    p_process_id: process.pid,
    p_last_error_message: lastErrorMessage,
    p_metadata: { runOnce, appBaseUrl, pollIntervalMs, heartbeatIntervalMs, limit, concurrency, leaseSeconds, ...metadata },
  });
  if (error) throw error;
  lastHeartbeatAt = Date.now();
}

async function tick() {
  if (!workerSecret) throw new Error('PROFILE_ANALYTICS_REFRESH_WORKER_SECRET, PUBLICATION_WORKER_SECRET ou CRON_SECRET é obrigatório.');
  const response = await fetch(`${appBaseUrl}/api/internal/profile-analytics-refresh-dispatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-profile-analytics-worker-secret': workerSecret },
    body: JSON.stringify({ workerId, limit, concurrency, leaseSeconds }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Dispatcher retornou HTTP ${response.status}.`);
  console.info('[profile-analytics-refresh-worker] ciclo concluído', payload);
  return payload;
}

async function main() {
  const supabase = createSupabase();
  console.info('[profile-analytics-refresh-worker] iniciando', { workerId, runOnce, appBaseUrl });
  await heartbeat(supabase, 'starting');

  while (!stopping) {
    try {
      const payload = await tick();
      lastTickHasMore = payload?.hasMore === true;
      const status = (payload?.chunks || 0) > 0 ? 'processing' : 'idle';
      if (Date.now() - lastHeartbeatAt >= heartbeatIntervalMs) await heartbeat(supabase, status, { payload });
    } catch (error) {
      lastTickHasMore = false;
      const message = error instanceof Error ? error.message : String(error);
      console.error('[profile-analytics-refresh-worker] falha no ciclo', error);
      await heartbeat(supabase, 'error', {}, message).catch((heartbeatError) => {
        console.error('[profile-analytics-refresh-worker] falha ao registrar heartbeat de erro', heartbeatError);
      });
    }

    if (runOnce) break;
    // Com backlog imediatamente elegível, mantém os dez slots ocupados. O
    // intervalo configurado continua protegendo o worker quando está ocioso.
    if (!stopping && !lastTickHasMore) await sleep(pollIntervalMs);
  }

  await heartbeat(supabase, 'stopped').catch((error) => console.error('[profile-analytics-refresh-worker] falha ao registrar parada', error));
  console.info('[profile-analytics-refresh-worker] finalizado', { workerId });
}

main().catch((error) => {
  console.error('[profile-analytics-refresh-worker] erro fatal', error);
  process.exitCode = 1;
});
