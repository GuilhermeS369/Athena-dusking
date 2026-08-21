#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';
import { randomUUID, createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

loadEnvFile('.env.local');
loadEnvFile('.env.worker');

const loadTestId = process.env.LOAD_TEST_ID || `load-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const organizationId = requiredEnv('LOAD_TEST_ORGANIZATION_ID');
const profileLimit = integerEnv('LOAD_TEST_PROFILE_LIMIT', 10, 1, 3000);
const postsPerProfile = integerEnv('LOAD_TEST_POSTS_PER_PROFILE', 24, 1, 1000);
const startOffsetMinutes = integerEnv('LOAD_TEST_START_OFFSET_MINUTES', 60 * 24 * 30, -60 * 24 * 365, 60 * 24 * 365);
const minutesBetweenPosts = integerEnv('LOAD_TEST_MINUTES_BETWEEN_POSTS', 60, 1, 60 * 24 * 30);
const chunkSize = integerEnv('LOAD_TEST_INSERT_CHUNK_SIZE', 500, 1, 1000);
const makeDueItems = process.env.LOAD_TEST_ALLOW_DUE_ITEMS === 'true';

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

function idempotencyKey(batchId, profileId, index) {
  return `load-test:${loadTestId}:${createHash('sha256').update(`${batchId}:${profileId}:${index}`).digest('hex')}`;
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60_000);
}

async function insertInChunks(supabase, table, rows) {
  for (let index = 0; index < rows.length; index += chunkSize) {
    const chunk = rows.slice(index, index + chunkSize);
    const { error } = await supabase.from(table).insert(chunk);
    if (error) throw error;
    console.info(`[load-test] inserido chunk em ${table}`, { inserted: Math.min(index + chunk.length, rows.length), total: rows.length });
  }
}

async function main() {
  if (startOffsetMinutes <= 0 && !makeDueItems) {
    throw new Error('Para criar itens vencidos/due, defina LOAD_TEST_ALLOW_DUE_ITEMS=true explicitamente. Use staging ou desligue workers reais antes.');
  }

  const supabase = createSupabase();
  const { data: organization, error: organizationError } = await supabase
    .from('organizations')
    .select('id, created_by')
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
  if (!profiles?.length) throw new Error('A organização precisa ter ao menos um perfil para o teste.');

  const batchId = randomUUID();
  const now = new Date();
  const scheduledFor = addMinutes(now, startOffsetMinutes).toISOString();
  const totalItems = profiles.length * postsPerProfile;
  console.info('[load-test] criando lote sintético', { loadTestId, organizationId, profiles: profiles.length, postsPerProfile, totalItems, scheduledFor });

  const { error: batchError } = await supabase.from('publication_batches').insert({
    id: batchId,
    organization_id: organizationId,
    created_by: organization.created_by,
    name: `[LOAD TEST ${loadTestId}] ${totalItems} itens`,
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
        organization_id: organizationId,
        batch_id: batchId,
        profile_id: profile.id,
        format: 'image',
        status: 'waiting',
        execute_at: addMinutes(now, startOffsetMinutes + postIndex * minutesBetweenPosts).toISOString(),
        caption: `[LOAD TEST ${loadTestId}] item ${globalIndex + 1}`,
        idempotency_key: idempotencyKey(batchId, profile.id, postIndex),
      });
    }
  });

  await insertInChunks(supabase, 'publication_items', rows);
  console.info('[load-test] seed concluído', { loadTestId, batchId, totalItems });
}

main().catch((error) => {
  console.error('[load-test] seed falhou', error);
  process.exitCode = 1;
});
