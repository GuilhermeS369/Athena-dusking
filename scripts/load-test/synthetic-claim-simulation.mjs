#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';
import { createHash, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

loadEnvFile('.env.local');
loadEnvFile('.env.worker');

const loadTestId = process.env.LOAD_TEST_ID || `synthetic-claim-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const profilesPerOrganization = integerEnv('LOAD_TEST_SYNTHETIC_PROFILES_PER_ORG', 10, 1, 300);
const postsPerProfile = integerEnv('LOAD_TEST_POSTS_PER_PROFILE', 24, 1, 240);
const claimLimit = integerEnv('LOAD_TEST_CLAIM_LIMIT', 25, 1, 100);
const leaseSeconds = integerEnv('LOAD_TEST_LEASE_SECONDS', 180, 30, 900);
const maxCycles = integerEnv('LOAD_TEST_MAX_CYCLES', 1000, 1, 100000);
const simulatedDelayMs = integerEnv('LOAD_TEST_SIMULATED_DELAY_MS', 0, 0, 60000);
const insertChunkSize = integerEnv('LOAD_TEST_INSERT_CHUNK_SIZE', 1000, 1, 1000);
const totalItemLimit = integerEnv('LOAD_TEST_TOTAL_ITEM_LIMIT', 5000, 1, 20000);
const keepData = process.env.LOAD_TEST_KEEP_DATA === 'true';
const workerId = process.env.LOAD_TEST_WORKER_ID || `synthetic-claim-${loadTestId}`.slice(0, 120);

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

function createSupabase() {
  return createClient(requiredEnv('NEXT_PUBLIC_SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60_000);
}

function slugFor() {
  const suffix = createHash('sha1').update(loadTestId).digest('hex').slice(0, 10);
  return `load-claim-${suffix}`;
}

function idempotencyKey(batchId, profileId, index) {
  return `load-claim:${loadTestId}:${createHash('sha256').update(`${batchId}:${profileId}:${index}`).digest('hex')}`;
}

async function insertInChunks(supabase, table, rows) {
  for (let index = 0; index < rows.length; index += insertChunkSize) {
    const chunk = rows.slice(index, index + insertChunkSize);
    const { error } = await supabase.from(table).insert(chunk);
    if (error) throw error;
    console.info(`[synthetic-claim] inserido chunk em ${table}`, { inserted: Math.min(index + chunk.length, rows.length), total: rows.length });
  }
}

async function creatorUserId(supabase) {
  const { data, error } = await supabase
    .from('organizations')
    .select('created_by')
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data?.created_by) throw new Error('Nenhum usuário criador foi encontrado para referenciar dados sintéticos.');
  return data.created_by;
}

async function queueSummary(supabase, organizationId = null) {
  const { data, error } = await supabase.rpc('get_publication_queue_operational_summary', {
    p_organization_id: organizationId,
  });
  if (error) throw error;
  return (data || []).reduce((summary, row) => {
    summary.total += row.total || 0;
    summary.expiredLeases += row.expired_leases || 0;
    summary.dueRetries += row.due_retries || 0;
    summary.overdue += row.overdue || 0;
    summary.maxLagSeconds = Math.max(summary.maxLagSeconds, row.max_lag_seconds || 0);
    summary.byStatus[row.status] = (summary.byStatus[row.status] || 0) + (row.total || 0);
    return summary;
  }, { total: 0, expiredLeases: 0, dueRetries: 0, overdue: 0, maxLagSeconds: 0, byStatus: {} });
}

async function globalHealth(supabase) {
  const { data, error } = await supabase.rpc('get_global_operational_health', {
    p_stale_after_seconds: 120,
    p_queue_lag_warning_seconds: 300,
    p_async_job_age_warning_seconds: 1800,
  });
  if (error) throw error;
  return Array.isArray(data) ? data[0] || null : data || null;
}

async function cleanupOrganization(supabase, organizationId) {
  if (!organizationId) return;
  const { error } = await supabase.from('organizations').delete().eq('id', organizationId);
  if (error) throw error;
}

async function main() {
  const totalItems = profilesPerOrganization * postsPerProfile;
  if (totalItems > totalItemLimit) {
    throw new Error(`Teste criaria ${totalItems} itens, acima de LOAD_TEST_TOTAL_ITEM_LIMIT=${totalItemLimit}.`);
  }

  const supabase = createSupabase();
  const createdBy = await creatorUserId(supabase);
  const organizationId = randomUUID();
  const batchId = randomUUID();
  const now = new Date();
  const scheduledFor = now.toISOString();
  const before = await queueSummary(supabase, null);
  const healthBefore = await globalHealth(supabase);
  const startedAt = Date.now();

  console.info('[synthetic-claim] iniciando', {
    loadTestId,
    organizationId,
    profilesPerOrganization,
    postsPerProfile,
    totalItems,
    claimLimit,
    leaseSeconds,
    maxCycles,
    simulatedDelayMs,
    workerId,
    keepData,
  });

  try {
    const { error: organizationError } = await supabase.from('organizations').insert({
      id: organizationId,
      name: `[LOAD CLAIM ${loadTestId}] Org 1`,
      slug: slugFor(),
      created_by: createdBy,
    });
    if (organizationError) throw organizationError;

    const profiles = Array.from({ length: profilesPerOrganization }, (_, profileIndex) => ({
      id: randomUUID(),
      organization_id: organizationId,
      instagram_user_id: `claim-${loadTestId}-${profileIndex + 1}`.slice(0, 80),
      username: `claim_${profileIndex + 1}_${slugFor().slice(-6)}`.slice(0, 80),
      display_name: `Claim Test ${profileIndex + 1}`,
      account_type: 'synthetic',
      capabilities: { synthetic: true, loadTestId, claimSimulation: true },
      encrypted_access_token: null,
      provider: 'zernio',
      zernio_account_id: `claim-${loadTestId}-${profileIndex + 1}`.slice(0, 160),
      zernio_account_metadata: { synthetic: true, loadTestId, claimSimulation: true },
      status: 'offline',
      created_by: createdBy,
    }));
    await insertInChunks(supabase, 'instagram_profiles', profiles);

    const { error: batchError } = await supabase.from('publication_batches').insert({
      id: batchId,
      organization_id: organizationId,
      created_by: createdBy,
      name: `[LOAD CLAIM ${loadTestId}] ${totalItems} itens sintéticos due`,
      status: 'queued',
      scheduled_for: scheduledFor,
      review_confirmed_at: now.toISOString(),
    });
    if (batchError) throw batchError;

    const items = [];
    profiles.forEach((profile, profileIndex) => {
      for (let postIndex = 0; postIndex < postsPerProfile; postIndex += 1) {
        const globalIndex = profileIndex * postsPerProfile + postIndex;
        items.push({
          organization_id: organizationId,
          batch_id: batchId,
          profile_id: profile.id,
          format: 'image',
          status: 'ready',
          execute_at: null,
          caption: `[LOAD CLAIM ${loadTestId}] synthetic item ${globalIndex + 1}`,
          idempotency_key: idempotencyKey(batchId, profile.id, postIndex),
        });
      }
    });
    await insertInChunks(supabase, 'publication_items', items);

    const afterInsert = await queueSummary(supabase, null);
    const healthAfterInsert = await globalHealth(supabase);

    let claimed = 0;
    let completed = 0;
    let failed = 0;
    for (let cycle = 1; cycle <= maxCycles; cycle += 1) {
      const { data: claimRows, error: claimError } = await supabase.rpc('claim_publication_items', {
        p_worker_id: workerId,
        p_limit: claimLimit,
        p_lease_seconds: leaseSeconds,
      });
      if (claimError) throw claimError;
      const syntheticClaims = (claimRows || []).filter((item) => item.organization_id === organizationId);
      if (!syntheticClaims.length) {
        console.info('[synthetic-claim] sem claims sintéticos restantes', { cycle, claimed, completed, failed });
        break;
      }

      claimed += syntheticClaims.length;
      for (const item of syntheticClaims) {
        if (simulatedDelayMs) await sleep(simulatedDelayMs);
        const { error: completeError } = await supabase.rpc('complete_publication_item', {
          p_item_id: item.id,
          p_worker_id: workerId,
          p_outcome: 'published',
          p_meta_media_id: `synthetic-claim-${item.id}`,
          p_error_code: null,
          p_error_message: null,
          p_retryable: false,
          p_max_attempts: 5,
        });
        if (completeError) {
          failed += 1;
          console.error('[synthetic-claim] falha ao concluir item', { itemId: item.id, message: completeError.message });
        } else {
          completed += 1;
        }
      }

      console.info('[synthetic-claim] ciclo concluído', { cycle, claimed: syntheticClaims.length, totalClaimed: claimed, completed, failed });
      if (completed >= totalItems) break;
    }

    const afterSimulation = await queueSummary(supabase, null);
    const healthAfterSimulation = await globalHealth(supabase);

    if (!keepData) await cleanupOrganization(supabase, organizationId);

    const afterCleanup = await queueSummary(supabase, null);
    const healthAfterCleanup = await globalHealth(supabase);
    const { count: remainingOrganizations, error: remainingOrganizationError } = await supabase
      .from('organizations')
      .select('id', { count: 'exact', head: true })
      .eq('id', organizationId);
    if (remainingOrganizationError) throw remainingOrganizationError;

    const elapsedMs = Date.now() - startedAt;
    console.info(JSON.stringify({
      checkedAt: new Date().toISOString(),
      loadTestId,
      organizationId,
      batchId,
      totalItems,
      claimed,
      completed,
      failed,
      elapsedMs,
      completedPerMinute: Math.round((completed / Math.max(1, elapsedMs / 1000)) * 60),
      remainingOrganizations: remainingOrganizations || 0,
      summaries: { before, afterInsert, afterSimulation, afterCleanup },
      health: { before: healthBefore, afterInsert: healthAfterInsert, afterSimulation: healthAfterSimulation, afterCleanup: healthAfterCleanup },
      safeGuards: {
        syntheticOnly: true,
        didNotCallProviderApis: true,
        usedRealClaimRpc: true,
        usedRealCompletionRpc: true,
        cleanupOrganization: !keepData,
      },
    }, null, 2));

    if (completed !== totalItems) throw new Error(`Simulação concluiu ${completed}/${totalItems} itens.`);
    if ((remainingOrganizations || 0) !== 0 && !keepData) throw new Error(`Restaram ${remainingOrganizations || 0} organizações sintéticas.`);
  } catch (error) {
    if (!keepData) {
      await cleanupOrganization(supabase, organizationId).catch((cleanupError) => {
        console.error('[synthetic-claim] limpeza de emergência falhou', cleanupError);
      });
    }
    throw error;
  }
}

main().catch((error) => {
  console.error('[synthetic-claim] falhou', error);
  process.exitCode = 1;
});
