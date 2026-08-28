#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

for (const filePath of ['.env.local', '.env.worker.deploy']) {
  if (!fs.existsSync(filePath)) continue;
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const separator = rawLine.indexOf('=');
    if (separator <= 0 || rawLine.trimStart().startsWith('#')) continue;
    const key = rawLine.slice(0, separator).trim();
    if (!process.env[key]) process.env[key] = rawLine.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  }
}

const apply = process.argv.includes('--apply');
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const selection = [
  'id', 'organization_id', 'batch_id', 'profile_id', 'format', 'status', 'execute_at', 'created_at',
  'creation_id', 'published_at', 'last_error_code', 'last_error_message', 'preparation_status', 'attempt_count',
  'instagram_profiles(username,status,deleted_at)',
  'publication_item_media(media_asset_id,media_assets(status,deleted_at,storage_path))',
].join(',');

async function fetchAll(buildQuery) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await buildQuery().range(offset, offset + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

const ignored = [];
for (const errorCode of ['duplicate_content_batch_overdue_ignored', 'paused_batch_overdue_story_ignored']) {
  ignored.push(...await fetchAll(() => supabase
    .from('publication_items')
    .select(selection)
    .eq('format', 'story')
    .eq('last_error_code', errorCode)));
}
const duplicateFailures = await fetchAll(() => supabase
  .from('publication_items')
  .select(selection)
  .eq('format', 'story')
  .eq('status', 'failed')
  .ilike('last_error_message', 'Duplicate content detected.%'));

const affected = [...new Map([...ignored, ...duplicateFailures].map((item) => [item.id, item])).values()]
  .filter((item) => item.status !== 'published' && !item.published_at);
const latestByProfile = [...Map.groupBy(affected, (item) => item.profile_id).values()].map((items) => items.sort((left, right) => (
  new Date(right.execute_at) - new Date(left.execute_at)
  || new Date(right.created_at) - new Date(left.created_at)
  || right.id.localeCompare(left.id)
))[0]);
const isExecutable = (item) => (
  item.instagram_profiles?.status === 'online'
  && !item.instagram_profiles?.deleted_at
  && item.publication_item_media?.length > 0
  && item.publication_item_media.every((link) => link.media_assets?.status === 'ready' && !link.media_assets.deleted_at)
);
const targets = latestByProfile.filter(isExecutable);
const skipped = latestByProfile.filter((item) => !isExecutable(item));
const counts = (items, key) => Object.fromEntries(
  [...Map.groupBy(items, (item) => item[key]).entries()].map(([value, rows]) => [value, rows.length]),
);
const summary = {
  mode: apply ? 'apply' : 'dry_run',
  affectedItems: affected.length,
  uniqueProfiles: latestByProfile.length,
  targets: targets.length,
  skipped: skipped.length,
  statuses: counts(targets, 'status'),
  withKnownCreation: targets.filter((item) => item.creation_id).length,
  withoutCreation: targets.filter((item) => !item.creation_id).length,
  organizations: new Set(targets.map((item) => item.organization_id)).size,
  batches: new Set(targets.map((item) => item.batch_id)).size,
};

if (!apply || targets.length === 0) {
  console.log(JSON.stringify({
    ...summary,
    skippedProfiles: skipped.map((item) => ({
      id: item.id,
      username: item.instagram_profiles?.username,
      profileStatus: item.instagram_profiles?.status,
      deletedAt: item.instagram_profiles?.deleted_at,
    })),
  }, null, 2));
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.resolve('artifacts', `latest-affected-stories-before-repost-${stamp}.json`);
fs.mkdirSync(path.dirname(backupPath), { recursive: true });
fs.writeFileSync(backupPath, JSON.stringify({ backedUpAt: new Date().toISOString(), targets, skipped }, null, 2));

const repostAt = new Date().toISOString();
const withoutCreation = targets.filter((item) => !item.creation_id);
const withKnownCreation = targets.filter((item) => item.creation_id);
const updated = [];
for (const group of [withoutCreation, withKnownCreation]) {
  for (let index = 0; index < group.length; index += 100) {
    const ids = group.slice(index, index + 100).map((item) => item.id);
    const values = {
      status: 'waiting',
      execute_at: repostAt,
      next_attempt_at: repostAt,
      claimed_by: null,
      lease_until: null,
      last_error_code: null,
      last_error_message: null,
      active_claim_consumed_attempt: false,
    };
    if (group === withoutCreation) Object.assign(values, {
      provider_creation_started_at: null,
      zernio_recovery_count: 0,
      zernio_recovery_poll_at: null,
    });
    const { data, error } = await supabase
      .from('publication_items')
      .update(values)
      .in('id', ids)
      .in('status', ['ignored', 'failed'])
      .is('published_at', null)
      .select('id,organization_id,batch_id,profile_id,status,creation_id');
    if (error) throw error;
    updated.push(...data);
  }
}
if (updated.length !== targets.length) {
  throw new Error(`Reabertura parcial: ${updated.length}/${targets.length}. Backup: ${backupPath}`);
}

const events = targets.map((item) => ({
  organization_id: item.organization_id,
  publication_item_id: item.id,
  event_type: 'retry_requested',
  previous_status: item.status,
  status: 'waiting',
  actor_label: 'system: latest-affected-story-repost',
  error_code: 'latest_affected_story_repost_requested',
  error_message: item.creation_id
    ? 'Último Story afetado do perfil devolvido ao polling da criação Zernio já conhecida; nenhuma nova criação será enviada.'
    : 'Último Story afetado do perfil liberado para uma nova publicação após correção da entrega direta de mídia.',
  metadata: {
    original_execute_at: item.execute_at,
    original_status: item.status,
    original_error_code: item.last_error_code,
    known_creation: Boolean(item.creation_id),
  },
}));
for (let index = 0; index < events.length; index += 250) {
  const { error } = await supabase.from('publication_item_events').insert(events.slice(index, index + 250));
  if (error) throw error;
}

console.log(JSON.stringify({
  ...summary,
  backupPath,
  repostAt,
  requeued: updated.length,
  auditEvents: events.length,
}, null, 2));
