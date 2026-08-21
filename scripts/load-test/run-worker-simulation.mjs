#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

loadEnvFile('.env.local');
loadEnvFile('.env.worker');

const workerId = process.env.LOAD_TEST_WORKER_ID || `load-test-${os.hostname()}-${process.pid}`;
const limit = integerEnv('LOAD_TEST_CLAIM_LIMIT', 5, 1, 100);
const leaseSeconds = integerEnv('LOAD_TEST_LEASE_SECONDS', 180, 30, 900);
const maxCycles = integerEnv('LOAD_TEST_MAX_CYCLES', 10, 1, 100000);
const delayMs = integerEnv('LOAD_TEST_SIMULATED_DELAY_MS', 100, 0, 60000);
const stopWhenEmpty = process.env.LOAD_TEST_STOP_WHEN_EMPTY !== 'false';

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

function integerEnv(name, fallback, minimum, maximum) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSupabase() {
  return createClient(requiredEnv('NEXT_PUBLIC_SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function main() {
  const supabase = createSupabase();
  let processed = 0;
  let failed = 0;
  const startedAt = Date.now();

  console.info('[load-test] simulação iniciada', { workerId, limit, leaseSeconds, maxCycles, delayMs });
  for (let cycle = 1; cycle <= maxCycles; cycle += 1) {
    const { data: claimed, error: claimError } = await supabase.rpc('claim_publication_items', {
      p_worker_id: workerId,
      p_limit: limit,
      p_lease_seconds: leaseSeconds,
    });
    if (claimError) throw claimError;
    const items = claimed || [];
    if (!items.length) {
      console.info('[load-test] nenhum item reivindicado', { cycle, processed, failed });
      if (stopWhenEmpty) break;
      await sleep(1000);
      continue;
    }

    for (const item of items) {
      if (delayMs) await sleep(delayMs);
      const { error: completeError } = await supabase.rpc('complete_publication_item', {
        p_item_id: item.id,
        p_worker_id: workerId,
        p_outcome: 'published',
        p_meta_media_id: `load-test-${item.id}`,
        p_error_code: null,
        p_error_message: null,
        p_retryable: false,
        p_max_attempts: 5,
      });
      if (completeError) {
        failed += 1;
        console.error('[load-test] falha ao concluir item', { itemId: item.id, message: completeError.message });
      } else {
        processed += 1;
      }
    }

    const elapsedSeconds = Math.max(1, (Date.now() - startedAt) / 1000);
    console.info('[load-test] ciclo concluído', {
      cycle,
      claimed: items.length,
      processed,
      failed,
      itemsPerMinute: Math.round((processed / elapsedSeconds) * 60),
    });
  }

  const elapsedSeconds = Math.max(1, (Date.now() - startedAt) / 1000);
  console.info('[load-test] simulação finalizada', {
    processed,
    failed,
    elapsedSeconds: Math.round(elapsedSeconds),
    itemsPerMinute: Math.round((processed / elapsedSeconds) * 60),
  });
}

main().catch((error) => {
  console.error('[load-test] simulação falhou', error);
  process.exitCode = 1;
});
