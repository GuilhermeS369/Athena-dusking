#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';
import { createHash, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

loadEnvFile('.env.local');
loadEnvFile('.env.worker');

const loadTestId = process.env.LOAD_TEST_ID || `synthetic-scale-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const organizationCount = integerEnv('LOAD_TEST_SYNTHETIC_ORGANIZATIONS', 1, 1, 10);
const profilesPerOrganization = integerEnv('LOAD_TEST_SYNTHETIC_PROFILES_PER_ORG', 100, 1, 3000);
const postsPerProfile = integerEnv('LOAD_TEST_POSTS_PER_PROFILE', 24, 1, 240);
const startOffsetMinutes = integerEnv('LOAD_TEST_START_OFFSET_MINUTES', 60 * 24 * 30, 60, 60 * 24 * 365);
const minutesBetweenPosts = integerEnv('LOAD_TEST_MINUTES_BETWEEN_POSTS', 60, 1, 60 * 24 * 30);
const insertChunkSize = integerEnv('LOAD_TEST_INSERT_CHUNK_SIZE', 1000, 1, 1000);
const totalItemLimit = integerEnv('LOAD_TEST_TOTAL_ITEM_LIMIT', 10000, 1, 72000);
const keepData = process.env.LOAD_TEST_KEEP_DATA === 'true';

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

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60_000);
}

function slugFor(index) {
  const suffix = createHash('sha1').update(`${loadTestId}:${index}`).digest('hex').slice(0, 10);
  return `load-test-${suffix}`;
}

function idempotencyKey(batchId, profileId, index) {
  return `load-test:${loadTestId}:${createHash('sha256').update(`${batchId}:${profileId}:${index}`).digest('hex')}`;
}

async function insertInChunks(supabase, table, rows) {
  for (let index = 0; index < rows.length; index += insertChunkSize) {
    const chunk = rows.slice(index, index + insertChunkSize);
    const { error } = await supabase.from(table).insert(chunk);
    if (error) throw error;
    console.info(`[synthetic-load-test] inserido chunk em ${table}`, { inserted: Math.min(index + chunk.length, rows.length), total: rows.length });
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

async function globalHealth(supabase) {
  const { data, error } = await supabase.rpc('get_global_operational_health', {
    p_stale_after_seconds: 120,
    p_queue_lag_warning_seconds: 300,
    p_async_job_age_warning_seconds: 1800,
  });
  if (error) throw error;
  return Array.isArray(data) ? data[0] || null : data || null;
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

async function cleanupOrganizations(supabase, organizationIds) {
  if (!organizationIds.length) return;
  const { error } = await supabase
    .from('organizations')
    .delete()
    .in('id', organizationIds);
  if (error) throw error;
}

async function main() {
  const totalItems = organizationCount * profilesPerOrganization * postsPerProfile;
  if (totalItems > totalItemLimit) {
    throw new Error(`Teste criaria ${totalItems} itens, acima de LOAD_TEST_TOTAL_ITEM_LIMIT=${totalItemLimit}. Aumente explicitamente o limite se estiver em staging/ambiente isolado.`);
  }

  const supabase = createSupabase();
  const createdBy = await creatorUserId(supabase);
  const now = new Date();
  const scheduledFor = addMinutes(now, startOffsetMinutes).toISOString();
  const before = await queueSummary(supabase, null);
  const healthBefore = await globalHealth(supabase);
  const createdOrganizationIds = [];
  const createdBatchIds = [];

  console.info('[synthetic-load-test] iniciando', {
    loadTestId,
    organizationCount,
    profilesPerOrganization,
    postsPerProfile,
    totalItems,
    scheduledFor,
    keepData,
  });

  const startedAt = Date.now();
  try {
    for (let orgIndex = 0; orgIndex < organizationCount; orgIndex += 1) {
      const organizationId = randomUUID();
      createdOrganizationIds.push(organizationId);
      const slug = slugFor(orgIndex);
      const { error: organizationError } = await supabase.from('organizations').insert({
        id: organizationId,
        name: `[LOAD TEST ${loadTestId}] Org ${orgIndex + 1}`,
        slug,
        created_by: createdBy,
      });
      if (organizationError) throw organizationError;

      const profiles = Array.from({ length: profilesPerOrganization }, (_, profileIndex) => ({
        id: randomUUID(),
        organization_id: organizationId,
        instagram_user_id: `synthetic-${loadTestId}-${orgIndex + 1}-${profileIndex + 1}`.slice(0, 80),
        username: `lt_${orgIndex + 1}_${profileIndex + 1}_${slug.slice(-6)}`.slice(0, 80),
        display_name: `Load Test ${orgIndex + 1}/${profileIndex + 1}`,
        account_type: 'synthetic',
        capabilities: { synthetic: true, loadTestId },
        encrypted_access_token: null,
        provider: 'zernio',
        zernio_account_id: `synthetic-${loadTestId}-${orgIndex + 1}-${profileIndex + 1}`.slice(0, 160),
        zernio_account_metadata: { synthetic: true, loadTestId },
        status: 'offline',
        created_by: createdBy,
      }));
      await insertInChunks(supabase, 'instagram_profiles', profiles);

      const batchId = randomUUID();
      createdBatchIds.push(batchId);
      const { error: batchError } = await supabase.from('publication_batches').insert({
        id: batchId,
        organization_id: organizationId,
        created_by: createdBy,
        name: `[LOAD TEST ${loadTestId}] ${profiles.length * postsPerProfile} itens sintéticos`,
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
            status: 'waiting',
            execute_at: addMinutes(now, startOffsetMinutes + postIndex * minutesBetweenPosts).toISOString(),
            caption: `[LOAD TEST ${loadTestId}] synthetic item ${globalIndex + 1}`,
            idempotency_key: idempotencyKey(batchId, profile.id, postIndex),
          });
        }
      });
      await insertInChunks(supabase, 'publication_items', items);
    }

    const afterInsert = await queueSummary(supabase, null);
    const healthAfterInsert = await globalHealth(supabase);

    if (!keepData) await cleanupOrganizations(supabase, createdOrganizationIds);

    const afterCleanup = await queueSummary(supabase, null);
    const healthAfterCleanup = await globalHealth(supabase);
    const elapsedMs = Date.now() - startedAt;

    let remainingSyntheticOrganizations = 0;
    if (!keepData) {
      const { count, error } = await supabase
        .from('organizations')
        .select('id', { count: 'exact', head: true })
        .in('id', createdOrganizationIds);
      if (error) throw error;
      remainingSyntheticOrganizations = count || 0;
    }

    console.info(JSON.stringify({
      checkedAt: new Date().toISOString(),
      loadTestId,
      organizationCount,
      profilesPerOrganization,
      postsPerProfile,
      totalItems,
      elapsedMs,
      itemsPerSecond: Math.round((totalItems / Math.max(1, elapsedMs / 1000)) * 100) / 100,
      createdOrganizationIds,
      createdBatchIds,
      remainingSyntheticOrganizations,
      summaries: { before, afterInsert, afterCleanup },
      health: { before: healthBefore, afterInsert: healthAfterInsert, afterCleanup: healthAfterCleanup },
      safeGuards: {
        futureOnly: true,
        startOffsetMinutes,
        syntheticProvider: 'zernio',
        didNotClaimItems: true,
        didNotCallProviderApis: true,
        cleanedUpOrganizations: !keepData,
      },
    }, null, 2));

    if (!keepData && remainingSyntheticOrganizations !== 0) throw new Error(`Restaram ${remainingSyntheticOrganizations} organizações sintéticas após limpeza.`);
  } catch (error) {
    if (!keepData) {
      await cleanupOrganizations(supabase, createdOrganizationIds).catch((cleanupError) => {
        console.error('[synthetic-load-test] limpeza de emergência falhou', cleanupError);
      });
    }
    throw error;
  }
}

main().catch((error) => {
  console.error('[synthetic-load-test] falhou', error);
  process.exitCode = 1;
});
