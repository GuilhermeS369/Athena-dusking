#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';
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

const itemId = process.argv.find((argument) => argument.startsWith('--item-id='))?.slice('--item-id='.length);
if (!itemId) throw new Error('Informe --item-id=<uuid>.');

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) throw new Error('Credenciais do Supabase não encontradas.');

const supabase = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: item, error: itemError } = await supabase
  .from('publication_items')
  .select('id, organization_id, batch_id, profile_id, format, status, execute_at, attempt_count, creation_id, next_attempt_at, last_error_code, last_error_message, published_at, created_at, updated_at, publication_item_media(position, media_asset_id, media_assets(id, original_name, mime_type, kind, size_bytes, storage_path, status, deleted_at, created_at)), publication_item_events(id, event_type, previous_status, status, actor_label, error_code, error_message, metadata, created_at)')
  .eq('id', itemId)
  .single();
if (itemError) throw itemError;

const mediaAssetIds = (item.publication_item_media ?? [])
  .map((media) => media.media_asset_id)
  .filter(Boolean);
const [attemptsResult, healthResult] = await Promise.all([
  mediaAssetIds.length === 0
    ? Promise.resolve({ data: [], error: null })
    : supabase
      .from('media_asset_delivery_attempts')
      .select('id, media_asset_id, publication_item_id, provider, phase, outcome, error_code, error_message, url_fingerprint, created_at')
      .in('media_asset_id', mediaAssetIds)
      .order('created_at', { ascending: false })
      .limit(100),
  mediaAssetIds.length === 0
    ? Promise.resolve({ data: [], error: null })
    : supabase
      .from('media_asset_delivery_health')
      .select('media_asset_id, consecutive_equivalent_failures, last_failure_code, last_failure_fingerprint, last_failure_at, last_success_at, quarantined_at, quarantine_reason, created_at, updated_at')
      .in('media_asset_id', mediaAssetIds),
]);
if (attemptsResult.error || healthResult.error) throw attemptsResult.error ?? healthResult.error;

const mediaUrlChecks = await Promise.all((item.publication_item_media ?? []).map(async (media) => {
  const asset = Array.isArray(media.media_assets) ? media.media_assets[0] : media.media_assets;
  if (!asset?.storage_path || asset.deleted_at || asset.status === 'deleted') {
    return { mediaAssetId: media.media_asset_id, outcome: 'not_checked', reason: 'Mídia removida ou sem caminho de armazenamento.' };
  }

  const { data, error } = await supabase.storage.from('instagram-media').createSignedUrl(asset.storage_path, 60 * 30);
  if (error || !data?.signedUrl) {
    return { mediaAssetId: asset.id, outcome: 'signed_url_failed', error: error?.message ?? 'URL temporária não retornada.' };
  }

  const summarizeResponse = async (method, range = false) => {
    try {
      const response = await fetch(data.signedUrl, {
        method,
        headers: range ? { Range: 'bytes=0-1023' } : undefined,
        redirect: 'follow',
        signal: AbortSignal.timeout(12_000),
      });
      await response.body?.cancel().catch(() => undefined);
      return {
        method,
        range,
        ok: response.ok,
        status: response.status,
        contentType: response.headers.get('content-type'),
        contentLength: response.headers.get('content-length'),
        acceptRanges: response.headers.get('accept-ranges'),
      };
    } catch (error) {
      return { method, range, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  return {
    mediaAssetId: asset.id,
    storagePath: asset.storage_path,
    checks: [await summarizeResponse('HEAD'), await summarizeResponse('GET', true)],
  };
}));

console.log(JSON.stringify({
  checkedAt: new Date().toISOString(),
  item,
  deliveryAttempts: attemptsResult.data ?? [],
  deliveryHealth: healthResult.data ?? [],
  mediaUrlChecks,
}, null, 2));
