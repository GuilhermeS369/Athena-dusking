#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

loadEnvFile('.env.local');
loadEnvFile('.env.worker');

const args = new Set(process.argv.slice(2).filter((arg) => !arg.startsWith('--') || !arg.includes('=')));
const options = Object.fromEntries(process.argv.slice(2).filter((arg) => arg.startsWith('--') && arg.includes('=')).map((arg) => {
  const separator = arg.indexOf('=');
  return [arg.slice(2, separator), arg.slice(separator + 1)];
}));

const statePath = path.resolve(options.state || 'tmp/publication-generation-large-smoke.json');
const smokeSource = 'large-generation-smoke';

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

function integerOption(name, fallback, minimum, maximum) {
  const parsed = Number.parseInt(options[name] || '', 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

function createSupabase() {
  return createClient(requiredEnv('NEXT_PUBLIC_SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function saveState(state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function loadState() {
  if (!fs.existsSync(statePath)) return null;
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

async function pickSmokeContext(supabase) {
  const { data: members, error: membersError } = await supabase
    .from('organization_members')
    .select('organization_id, user_id, role')
    .in('role', ['admin', 'operator'])
    .limit(100);
  if (membersError) throw membersError;

  for (const member of members ?? []) {
    const [{ data: profile, error: profileError }, { data: media, error: mediaError }, { data: organization, error: organizationError }] = await Promise.all([
      supabase
        .from('instagram_profiles')
        .select('id, username')
        .eq('organization_id', member.organization_id)
        .is('deleted_at', null)
        .limit(1)
        .maybeSingle(),
      supabase
        .from('media_assets')
        .select('id, kind, original_name')
        .eq('organization_id', member.organization_id)
        .eq('kind', 'image')
        .eq('status', 'ready')
        .is('deleted_at', null)
        .is('deletion_requested_at', null)
        .limit(1)
        .maybeSingle(),
      supabase
        .from('organizations')
        .select('id, name')
        .eq('id', member.organization_id)
        .maybeSingle(),
    ]);
    if (profileError) throw profileError;
    if (mediaError) throw mediaError;
    if (organizationError) throw organizationError;
    if (profile && media) return { member, profile, media, organization };
  }

  throw new Error('Não encontrei organização com operador/admin, perfil conectado e imagem pronta para smoke test.');
}

function buildItems({ runId, profileId, mediaId, itemCount }) {
  const randomDayOffset = Number.parseInt(runId.replaceAll('-', '').slice(0, 6), 16) % 365;
  const start = Date.UTC(2035, 0, 1 + randomDayOffset, 12, 0, 0);
  return Array.from({ length: itemCount }, (_, index) => ({
    profileId,
    format: 'image',
    executeAt: new Date(start + index * 60_000).toISOString(),
    scheduleTime: null,
    scheduleBaseAt: null,
    caption: `Smoke test grande de geração ${runId} — item ${index + 1}`,
    idempotencyKey: `${smokeSource}:${runId}:${index}`,
    mediaIds: [mediaId],
  }));
}

async function createSmokeJob(supabase) {
  const itemCount = integerOption('items', 501, 501, 50_000);
  const chunkSize = integerOption('chunk-size', 500, 1, 1000);
  const runId = options['run-id'] || randomUUID();
  const context = await pickSmokeContext(supabase);
  const items = buildItems({ runId, profileId: context.profile.id, mediaId: context.media.id, itemCount });

  const { data: job, error: jobError } = await supabase
    .from('publication_generation_jobs')
    .insert({
      organization_id: context.member.organization_id,
      created_by: context.member.user_id,
      created_by_email: null,
      name: `Smoke geração grande ${runId.slice(0, 8)}`,
      scheduled_for: null,
      payload: {
        kind: 'publication-generation',
        version: 1,
        source: smokeSource,
        items,
      },
      expected_items: itemCount,
      chunk_size: chunkSize,
      metadata: {
        source: smokeSource,
        smokeTestRunId: runId,
        cleanupRequired: true,
        createdByScript: 'scripts/workers/smoke-large-generation-job.mjs',
      },
    })
    .select('id, organization_id, status, expected_items, generated_items, failed_items, chunk_size, chunk_count, batch_id, created_at')
    .single();
  if (jobError) throw jobError;

  await supabase.from('publication_generation_job_events').insert({
    job_id: job.id,
    organization_id: job.organization_id,
    event_type: 'queued',
    previous_status: null,
    status: job.status,
    actor_user_id: context.member.user_id,
    actor_label: smokeSource,
    message: 'Smoke test grande criado diretamente por script operacional.',
    metadata: { smokeTestRunId: runId, expectedItems: itemCount, chunkSize },
  });

  const state = {
    runId,
    jobId: job.id,
    organizationId: context.member.organization_id,
    createdBy: context.member.user_id,
    profileId: context.profile.id,
    mediaId: context.media.id,
    expectedItems: itemCount,
    chunkSize,
    statePath,
  };
  saveState(state);
  return { action: 'created', ...state, job };
}

async function inspectSmokeJob(supabase) {
  const state = loadState();
  const runId = options['run-id'] || state?.runId;
  if (!runId) throw new Error('Informe --run-id ou mantenha o arquivo de estado do smoke test.');

  const { data: jobs, error: jobsError } = await supabase
    .from('publication_generation_jobs')
    .select('id, organization_id, status, expected_items, generated_items, failed_items, chunk_size, chunk_count, batch_id, claimed_by, lease_until, last_error_message, metadata, created_at, updated_at, completed_at')
    .eq('metadata->>smokeTestRunId', runId)
    .order('created_at', { ascending: false });
  if (jobsError) throw jobsError;
  const job = jobs?.[0] ?? null;
  if (!job) return { action: 'inspect', runId, found: false };

  const [{ data: chunks, error: chunksError }, itemCountResult] = await Promise.all([
    supabase
      .from('publication_generation_job_chunks')
      .select('id, chunk_index, status, expected_items, generated_items, failed_items, attempt_count, last_error_message, completed_at')
      .eq('job_id', job.id)
      .order('chunk_index', { ascending: true }),
    job.batch_id
      ? supabase.from('publication_items').select('id', { count: 'exact', head: true }).eq('batch_id', job.batch_id)
      : Promise.resolve({ count: 0, error: null }),
  ]);
  if (chunksError) throw chunksError;
  if (itemCountResult.error) throw itemCountResult.error;

  let sampledMediaLinkCount = 0;
  let sampledItemCount = 0;
  if (job.batch_id) {
    const { data: itemIds, error: itemIdsError } = await supabase
      .from('publication_items')
      .select('id')
      .eq('batch_id', job.batch_id)
      .limit(20);
    if (itemIdsError) throw itemIdsError;
    const ids = (itemIds ?? []).map((item) => item.id);
    sampledItemCount = ids.length;
    if (ids.length > 0) {
      const { count, error } = await supabase
        .from('publication_item_media')
        .select('publication_item_id', { count: 'exact', head: true })
        .in('publication_item_id', ids);
      if (error) throw error;
      sampledMediaLinkCount = count ?? 0;
    }
  }

  return {
    action: 'inspect',
    runId,
    found: true,
    job,
    chunks: chunks ?? [],
    itemCount: itemCountResult.count ?? 0,
    sampledItemCount,
    sampledMediaLinkCount,
  };
}

async function cleanupSmokeJob(supabase) {
  const state = loadState();
  const runId = options['run-id'] || state?.runId;
  if (!runId) throw new Error('Informe --run-id ou mantenha o arquivo de estado do smoke test.');

  const before = await inspectSmokeJob(supabase);
  if (!before.found) return { action: 'cleanup', runId, found: false, removed: false };

  if (before.job.batch_id) {
    const { error: batchError } = await supabase.from('publication_batches').delete().eq('id', before.job.batch_id);
    if (batchError) throw batchError;
  }
  const { error: jobError } = await supabase.from('publication_generation_jobs').delete().eq('id', before.job.id);
  if (jobError) throw jobError;
  if (fs.existsSync(statePath)) fs.rmSync(statePath);

  return { action: 'cleanup', runId, found: true, removed: true, before };
}

async function main() {
  const supabase = createSupabase();
  let result;
  if (args.has('--create')) result = await createSmokeJob(supabase);
  else if (args.has('--inspect')) result = await inspectSmokeJob(supabase);
  else if (args.has('--cleanup')) result = await cleanupSmokeJob(supabase);
  else throw new Error('Use --create, --inspect ou --cleanup.');
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
