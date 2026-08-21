#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';
import { createHash, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

loadEnvFile('.env.local');
loadEnvFile('.env.worker');

const loadTestId = process.env.LOAD_TEST_ID || `phase8-smoke-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const requestedOrganizationId = process.env.LOAD_TEST_ORGANIZATION_ID || null;
const profileLimit = integerEnv('LOAD_TEST_PROFILE_LIMIT', 10, 1, 300);
const postsPerProfile = integerEnv('LOAD_TEST_POSTS_PER_PROFILE', 24, 1, 240);
const startOffsetMinutes = integerEnv('LOAD_TEST_START_OFFSET_MINUTES', 60 * 24 * 30, 60, 60 * 24 * 365);
const minutesBetweenPosts = integerEnv('LOAD_TEST_MINUTES_BETWEEN_POSTS', 60, 1, 60 * 24 * 30);
const chunkSize = integerEnv('LOAD_TEST_INSERT_CHUNK_SIZE', 500, 1, 1000);

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

function idempotencyKey(batchId, profileId, index) {
  return `load-test:${loadTestId}:${createHash('sha256').update(`${batchId}:${profileId}:${index}`).digest('hex')}`;
}

async function insertInChunks(supabase, table, rows) {
  for (let index = 0; index < rows.length; index += chunkSize) {
    const chunk = rows.slice(index, index + chunkSize);
    const { error } = await supabase.from(table).insert(chunk);
    if (error) throw error;
    console.info(`[load-test] inserido chunk em ${table}`, { inserted: Math.min(index + chunk.length, rows.length), total: rows.length });
  }
}

async function loadOrganizationAndProfiles(supabase) {
  let organizationId = requestedOrganizationId;
  if (!organizationId) {
    const { data: profile, error: profileError } = await supabase
      .from('instagram_profiles')
      .select('organization_id')
      .is('deleted_at', null)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (profileError) throw profileError;
    organizationId = profile?.organization_id || null;
  }
  if (!organizationId) throw new Error('Nenhuma organização com perfil ativo foi encontrada para o smoke seguro.');

  const { data: organization, error: organizationError } = await supabase
    .from('organizations')
    .select('id, name, created_by')
    .eq('id', organizationId)
    .maybeSingle();
  if (organizationError || !organization) throw organizationError || new Error('Organização de teste não encontrada.');

  const { data: profiles, error: profilesError } = await supabase
    .from('instagram_profiles')
    .select('id')
    .eq('organization_id', organizationId)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(profileLimit);
  if (profilesError) throw profilesError;
  if (!profiles?.length) throw new Error('A organização precisa ter ao menos um perfil ativo para o smoke seguro.');

  return { organization, profiles };
}

async function queueSummary(supabase, organizationId) {
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

async function main() {
  const supabase = createSupabase();
  const { organization, profiles } = await loadOrganizationAndProfiles(supabase);
  const batchId = randomUUID();
  const now = new Date();
  const scheduledFor = addMinutes(now, startOffsetMinutes).toISOString();
  const totalItems = profiles.length * postsPerProfile;
  const before = await queueSummary(supabase, organization.id);

  console.info('[load-test] smoke seguro iniciando', {
    loadTestId,
    organizationId: organization.id,
    organizationName: organization.name,
    profiles: profiles.length,
    postsPerProfile,
    totalItems,
    scheduledFor,
  });

  const { error: batchError } = await supabase.from('publication_batches').insert({
    id: batchId,
    organization_id: organization.id,
    created_by: organization.created_by,
    name: `[LOAD TEST ${loadTestId}] smoke seguro ${totalItems} itens`,
    status: 'queued',
    scheduled_for: scheduledFor,
    review_confirmed_at: now.toISOString(),
  });
  if (batchError) throw batchError;

  const rows = [];
  profiles.forEach((profile, profileIndex) => {
    for (let postIndex = 0; postIndex < postsPerProfile; postIndex += 1) {
      const globalIndex = profileIndex * postsPerProfile + postIndex;
      rows.push({
        organization_id: organization.id,
        batch_id: batchId,
        profile_id: profile.id,
        format: 'image',
        status: 'waiting',
        execute_at: addMinutes(now, startOffsetMinutes + postIndex * minutesBetweenPosts).toISOString(),
        caption: `[LOAD TEST ${loadTestId}] smoke item ${globalIndex + 1}`,
        idempotency_key: idempotencyKey(batchId, profile.id, postIndex),
      });
    }
  });

  const insertStartedAt = Date.now();
  await insertInChunks(supabase, 'publication_items', rows);
  const insertElapsedMs = Date.now() - insertStartedAt;

  const { count: insertedCount, error: countError } = await supabase
    .from('publication_items')
    .select('id', { count: 'exact', head: true })
    .eq('batch_id', batchId);
  if (countError) throw countError;

  const afterInsert = await queueSummary(supabase, organization.id);

  const { error: cleanupError } = await supabase
    .from('publication_batches')
    .delete()
    .eq('organization_id', organization.id)
    .eq('id', batchId);
  if (cleanupError) throw cleanupError;

  const { count: remainingCount, error: remainingError } = await supabase
    .from('publication_items')
    .select('id', { count: 'exact', head: true })
    .eq('batch_id', batchId);
  if (remainingError) throw remainingError;

  const afterCleanup = await queueSummary(supabase, organization.id);

  console.info(JSON.stringify({
    checkedAt: new Date().toISOString(),
    loadTestId,
    organizationId: organization.id,
    batchId,
    requestedItems: totalItems,
    insertedItems: insertedCount || 0,
    remainingItemsAfterCleanup: remainingCount || 0,
    insertElapsedMs,
    insertItemsPerSecond: Math.round((totalItems / Math.max(1, insertElapsedMs / 1000)) * 100) / 100,
    summaries: { before, afterInsert, afterCleanup },
    safeGuards: {
      futureOnly: true,
      startOffsetMinutes,
      didNotClaimItems: true,
      didNotCallProviderApis: true,
      cleanedUpBatch: true,
    },
  }, null, 2));

  if ((insertedCount || 0) !== totalItems) throw new Error(`Smoke inseriu ${insertedCount || 0}/${totalItems} itens.`);
  if ((remainingCount || 0) !== 0) throw new Error(`Smoke deixou ${remainingCount || 0} itens após limpeza.`);
}

main().catch((error) => {
  console.error('[load-test] smoke seguro falhou', error);
  process.exitCode = 1;
});
