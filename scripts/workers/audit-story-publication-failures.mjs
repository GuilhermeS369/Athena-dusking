#!/usr/bin/env node

import fs from 'node:fs';
import { createDecipheriv } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

for (const filePath of ['.env.local', '.env.worker.deploy']) {
  if (!fs.existsSync(filePath)) continue;
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (process.env[key]) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) throw new Error('Credenciais do Supabase não encontradas.');

const supabase = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
const hours = Math.min(Math.max(Number.parseInt(process.argv.find((value) => value.startsWith('--hours='))?.slice(8) ?? '168', 10), 1), 24 * 60);
const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
const reconcileRemote = process.argv.includes('--reconcile-remote');
const applyConfirmed = process.argv.includes('--apply-confirmed');
if (applyConfirmed && !reconcileRemote) throw new Error('--apply-confirmed exige --reconcile-remote.');

function decryptToken(payload) {
  const [version, ivValue, tagValue, encryptedValue] = String(payload ?? '').split('.');
  const key = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY ?? '', 'base64');
  if (version !== 'v1' || !ivValue || !tagValue || !encryptedValue || key.length !== 32) return null;
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]).toString('utf8');
}

async function safeZernioGet(apiKey, path) {
  if (!apiKey) return { checked: false, reason: 'token_encryption_key_unavailable' };
  const baseUrl = process.env.ZERNIO_API_BASE_URL ?? 'https://zernio.com/api';
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(25_000),
    });
    const payload = await response.json().catch(() => ({}));
    return { checked: true, ok: response.ok, status: response.status, payload };
  } catch (error) {
    return { checked: true, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function remoteId(value) {
  if (typeof value === 'string') return value;
  return value?._id ?? value?.id ?? value?.accountId ?? null;
}

function compactRemotePost(post, expectedAccountId, expectedStoragePaths = []) {
  const platform = (post?.platforms ?? []).find((entry) => entry.platform === 'instagram' && remoteId(entry.accountId) === expectedAccountId)
    ?? (post?.platforms ?? []).find((entry) => entry.platform === 'instagram')
    ?? null;
  const mediaUrls = (post?.mediaItems ?? []).map((media) => String(media?.url ?? ''));
  const matchingStoragePaths = expectedStoragePaths.filter((storagePath) => mediaUrls.some((url) => {
    try {
      return decodeURIComponent(new URL(url).pathname).endsWith(`/${storagePath}`);
    } catch {
      return url.includes(storagePath);
    }
  }));
  return {
    postId: remoteId(post),
    postStatus: post?.status ?? null,
    platformStatus: platform?.status ?? null,
    contentType: platform?.platformSpecificData?.contentType ?? null,
    accountId: remoteId(platform?.accountId),
    createdAt: post?.createdAt ?? null,
    scheduledFor: platform?.scheduledFor ?? post?.scheduledFor ?? null,
    publishedAt: platform?.publishedAt ?? post?.publishedAt ?? null,
    platformPostId: platform?.platformPostId ?? null,
    matchedMediaCount: matchingStoragePaths.length,
    expectedMediaCount: expectedStoragePaths.length,
    matchingStoragePaths,
  };
}

async function pooledMap(values, concurrency, mapper) {
  const result = new Array(values.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      result[index] = await mapper(values[index], index);
    }
  }));
  return result;
}

async function allPages(makeQuery, pageSize = 1000) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await makeQuery().range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if ((data ?? []).length < pageSize) return rows;
  }
}

const profiles = await allPages(() => supabase
  .from('instagram_profiles')
  .select('id,organization_id,username,provider,status,zernio_account_id,zernio_connection_id,zernio_profile_id,deleted_at,created_at,updated_at')
  .is('deleted_at', null)
  .order('id'));
const profileById = new Map(profiles.map((profile) => [profile.id, profile]));

const items = await allPages(() => supabase
  .from('publication_items')
  .select('id,organization_id,batch_id,profile_id,idempotency_key,format,status,execute_at,attempt_count,creation_id,next_attempt_at,last_error_code,last_error_message,published_at,created_at,updated_at,zernio_recovery_count,zernio_recovery_poll_at')
  .eq('format', 'story')
  .gte('execute_at', cutoff)
  .order('execute_at', { ascending: true })
  .order('id', { ascending: true }));

const relevantItems = items.filter((item) => ['failed', 'suspended', 'waiting', 'ready', 'preparing', 'publishing', 'published'].includes(item.status));
const relevantItemIds = relevantItems.map((item) => item.id);
const events = [];
for (let index = 0; index < relevantItemIds.length; index += 200) {
  const ids = relevantItemIds.slice(index, index + 200);
  const page = await allPages(() => supabase
    .from('publication_item_events')
    .select('publication_item_id,event_type,previous_status,status,actor_label,error_code,error_message,metadata,created_at')
    .in('publication_item_id', ids)
    .order('created_at', { ascending: true }));
  events.push(...page);
}

const eventsByItemId = Map.groupBy(events, (event) => event.publication_item_id);
const enriched = relevantItems.map((item) => ({
  ...item,
  profile: profileById.get(item.profile_id) ?? null,
  events: eventsByItemId.get(item.id) ?? [],
}));
const failed = enriched.filter((item) => ['failed', 'suspended'].includes(item.status));
const errorGroups = [...Map.groupBy(failed, (item) => `${item.last_error_code ?? 'sem_codigo'}|${item.last_error_message ?? 'sem_mensagem'}`).entries()]
  .map(([key, rows]) => ({
    key,
    count: rows.length,
    profiles: [...new Set(rows.map((row) => row.profile?.username ?? row.profile_id))].sort(),
    providers: Object.fromEntries([...Map.groupBy(rows, (row) => row.profile?.provider ?? 'unknown').entries()].map(([provider, values]) => [provider, values.length])),
    sampleItemIds: rows.slice(0, 10).map((row) => row.id),
  }))
  .sort((left, right) => right.count - left.count);

const brooks = enriched.filter((item) => item.profile?.username?.toLocaleLowerCase('en-US') === 'brooks291024');
const profilesWithFailures = [...Map.groupBy(failed, (item) => item.profile_id).entries()]
  .map(([profileId, rows]) => ({
    profile: profileById.get(profileId) ?? null,
    failedCount: rows.length,
    errorCodes: Object.fromEntries([...Map.groupBy(rows, (row) => row.last_error_code ?? 'sem_codigo').entries()].map(([code, values]) => [code, values.length])),
    firstFailureAt: rows[0]?.updated_at ?? null,
    lastFailureAt: rows.at(-1)?.updated_at ?? null,
    itemIds: rows.map((row) => row.id),
  }))
  .sort((left, right) => right.failedCount - left.failedCount);

const telemetryCutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
const [heartbeatsResult, rollupsResult, anomaliesResult] = await Promise.all([
  supabase
    .from('publication_worker_heartbeats')
    .select('worker_id,worker_kind,status,dry_run,last_seen_at,last_error_message,metadata')
    .eq('worker_kind', 'publication')
    .order('last_seen_at', { ascending: false })
    .limit(20),
  supabase
    .from('zernio_publication_request_rollups')
    .select('*')
    .gte('window_started_at', telemetryCutoff)
    .order('window_started_at', { ascending: false })
    .limit(2000),
  supabase
    .from('zernio_publication_request_anomalies')
    .select('*')
    .gte('occurred_at', telemetryCutoff)
    .order('occurred_at', { ascending: false })
    .limit(2000),
]);
if (heartbeatsResult.error || rollupsResult.error || anomaliesResult.error) {
  throw heartbeatsResult.error ?? rollupsResult.error ?? anomaliesResult.error;
}

let remoteFailureReconciliation = { enabled: false, rows: [], summary: {} };
if (reconcileRemote) {
  const failedItemIds = failed.map((item) => item.id);
  const mediaRows = [];
  for (let index = 0; index < failedItemIds.length; index += 200) {
    const ids = failedItemIds.slice(index, index + 200);
    const page = await allPages(() => supabase
      .from('publication_item_media')
      .select('publication_item_id,media_assets(storage_path)')
      .in('publication_item_id', ids)
      .order('publication_item_id'));
    mediaRows.push(...page);
  }
  const mediaPathsByItem = new Map();
  for (const row of mediaRows) {
    const asset = Array.isArray(row.media_assets) ? row.media_assets[0] : row.media_assets;
    if (!asset?.storage_path) continue;
    mediaPathsByItem.set(row.publication_item_id, [...(mediaPathsByItem.get(row.publication_item_id) ?? []), asset.storage_path]);
  }

  const connectionIds = [...new Set(failed.map((item) => item.profile?.zernio_connection_id).filter(Boolean))];
  const { data: connections, error: connectionsError } = connectionIds.length
    ? await supabase.from('zernio_connections').select('id,encrypted_api_key,status').in('id', connectionIds)
    : { data: [], error: null };
  if (connectionsError) throw connectionsError;
  const apiKeyByConnection = new Map((connections ?? []).map((connection) => [connection.id, decryptToken(connection.encrypted_api_key)]));

  const rows = await pooledMap(failed, 4, async (item) => {
    const accountId = item.profile?.zernio_account_id;
    const apiKey = apiKeyByConnection.get(item.profile?.zernio_connection_id);
    if (!accountId || !apiKey) return { itemId: item.id, username: item.profile?.username, classification: 'not_queryable' };
    const expectedStoragePaths = mediaPathsByItem.get(item.id) ?? [];
    const existingPostId = item.last_error_code === '409'
      ? item.last_error_message?.match(/"existingPostId"\s*:\s*"([^"]+)"/)?.[1] ?? null
      : null;
    let response;
    if (existingPostId) {
      response = await safeZernioGet(apiKey, `/v1/posts/${encodeURIComponent(existingPostId)}`);
    } else {
      const from = new Date(Date.parse(item.execute_at) - 10 * 60_000).toISOString();
      const to = new Date(Date.parse(item.execute_at) + 60 * 60_000).toISOString();
      const query = new URLSearchParams({ accountId, source: 'zernio', dateFrom: from, dateTo: to, limit: '100', sortBy: 'created-asc' });
      response = await safeZernioGet(apiKey, `/v1/posts?${query}`);
    }
    if (!response.ok) return {
      itemId: item.id, username: item.profile?.username, classification: 'query_error',
      httpStatus: response.status ?? null, error: response.error ?? response.payload?.message ?? response.payload?.error ?? null,
    };
    const candidates = (existingPostId ? [response.payload?.post] : response.payload?.posts ?? [])
      .filter(Boolean)
      .map((post) => compactRemotePost(post, accountId, expectedStoragePaths))
      .filter((post) => post.contentType === 'story' && post.accountId === accountId)
      .sort((left, right) => right.matchedMediaCount - left.matchedMediaCount);
    const exactMedia = candidates.filter((post) => expectedStoragePaths.length > 0 && post.matchedMediaCount === expectedStoragePaths.length);
    const selected = exactMedia[0] ?? (candidates.length === 1 ? candidates[0] : null);
    const published = selected && ['published', 'success', 'posted', 'completed'].includes(String(selected.platformStatus ?? selected.postStatus).toLowerCase());
    return {
      itemId: item.id,
      username: item.profile?.username,
      localStatus: item.status,
      localErrorCode: item.last_error_code,
      executeAt: item.execute_at,
      classification: published ? 'published_remotely' : selected ? 'remote_candidate_not_published' : candidates.length > 1 ? 'ambiguous_remote_candidates' : 'no_remote_match',
      selected,
      candidates,
    };
  });
  remoteFailureReconciliation = {
    enabled: true,
    rows,
    summary: Object.fromEntries([...Map.groupBy(rows, (row) => row.classification).entries()].map(([classification, values]) => [classification, values.length])),
  };

  if (applyConfirmed) {
    const confirmed = rows.filter((row) => row.classification === 'published_remotely' && row.selected?.postId);
    const workerId = `historical-zernio-reconcile-${new Date().toISOString().slice(0, 10)}`;
    const applied = await pooledMap(confirmed, 4, async (row) => {
      const { data, error } = await supabase.rpc('reconcile_zernio_publication_item', {
        p_item_id: row.itemId,
        p_worker_id: workerId,
        p_creation_id: row.selected.postId,
        p_meta_media_id: row.selected.platformPostId ?? null,
      });
      return error
        ? { itemId: row.itemId, applied: false, error: error.message }
        : { itemId: row.itemId, applied: true, result: data };
    });
    remoteFailureReconciliation.apply = {
      requested: true,
      workerId,
      confirmed: confirmed.length,
      succeeded: applied.filter((row) => row.applied).length,
      failed: applied.filter((row) => !row.applied).length,
      rows: applied,
    };
  }
}

const brooksProfile = profiles.find((profile) => profile.username?.toLocaleLowerCase('en-US') === 'brooks291024') ?? null;
let brooksRemote = { checked: false, reason: 'profile_or_connection_unavailable' };
if (brooksProfile?.zernio_connection_id && brooksProfile.zernio_account_id) {
  const { data: connection, error: connectionError } = await supabase
    .from('zernio_connections')
    .select('id,label,status,encrypted_api_key,last_checked_at,last_sync_at,last_error_code,last_error_message')
    .eq('id', brooksProfile.zernio_connection_id)
    .maybeSingle();
  if (connectionError) throw connectionError;
  const apiKey = decryptToken(connection?.encrypted_api_key);
  const publishedCreationIds = brooks.filter((item) => item.creation_id).map((item) => item.creation_id);
  const [accountStories, ...publishedPosts] = await Promise.all([
    safeZernioGet(apiKey, `/v1/accounts/${encodeURIComponent(brooksProfile.zernio_account_id)}/instagram/stories`),
    ...publishedCreationIds.map((creationId) => safeZernioGet(apiKey, `/v1/posts/${encodeURIComponent(creationId)}`)),
  ]);
  brooksRemote = {
    checked: true,
    connection: connection ? { ...connection, encrypted_api_key: undefined } : null,
    activeStories: accountStories,
    publishedPosts,
  };
}

console.log(JSON.stringify({
  checkedAt: new Date().toISOString(),
  cutoff,
  hours,
  totals: {
    stories: enriched.length,
    published: enriched.filter((item) => item.status === 'published').length,
    failed: enriched.filter((item) => item.status === 'failed').length,
    suspended: enriched.filter((item) => item.status === 'suspended').length,
    active: enriched.filter((item) => ['waiting', 'ready', 'preparing', 'publishing'].includes(item.status)).length,
    profilesWithFailures: profilesWithFailures.length,
  },
  errorGroups,
  profilesWithFailures,
  brooks291024: {
    profiles: profiles.filter((profile) => profile.username?.toLocaleLowerCase('en-US') === 'brooks291024'),
    items: brooks,
    remote: brooksRemote,
  },
  workerAndZernioTelemetry: {
    cutoff: telemetryCutoff,
    heartbeats: heartbeatsResult.data ?? [],
    rollups: rollupsResult.data ?? [],
    anomalies: anomaliesResult.data ?? [],
  },
  remoteFailureReconciliation,
  failedItems: failed,
}, null, 2));
