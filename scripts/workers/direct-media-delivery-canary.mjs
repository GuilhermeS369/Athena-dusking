import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

import { flushZernioRequestTelemetry, processClaimedItem } from './publication-direct-dispatch.mjs';

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

function createSupabase() {
  return createClient(
    requiredEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

async function rowsInChunks(values, query) {
  const rows = [];
  for (const page of chunks(values, 200)) rows.push(...await query(page));
  return rows;
}

async function discoverCandidates(supabase, options = {}) {
  const { data: breakers, error: breakersError } = await supabase
    .from('publication_batch_circuit_breakers')
    .select('batch_id')
    .not('paused_at', 'is', null);
  if (breakersError) throw breakersError;
  const batchIds = breakers.map((row) => row.batch_id);
  if (!options.includeUnpaused && batchIds.length === 0) return [];

  const upperBound = new Date(Date.now() + (options.futureHours ?? 0) * 60 * 60_000).toISOString();
  const loadCandidates = async (batchPage = null) => {
    let query = supabase
      .from('publication_items')
      .select('id, organization_id, batch_id, profile_id, format, status, execute_at, preparation_status')
      .in('format', options.formats ?? ['story', 'reel'])
      .in('status', ['waiting', 'ready'])
      .is('creation_id', null)
      .eq('preparation_status', 'ready')
      .lte('execute_at', upperBound)
      .order('execute_at')
      .limit(5000);
    if (batchPage) query = query.in('batch_id', batchPage);
    const { data, error } = await query;
    if (error) throw error;
    return data;
  };
  const candidates = options.includeUnpaused
    ? await loadCandidates()
    : await rowsInChunks(batchIds, async (batchPage) => {
      return loadCandidates(batchPage);
    });
  if (candidates.length === 0) return [];

  const candidateMedia = await rowsInChunks(candidates.map((row) => row.id), async (itemIds) => {
    const { data, error } = await supabase
      .from('publication_item_media')
      .select('publication_item_id, media_asset_id')
      .in('publication_item_id', itemIds);
    if (error) throw error;
    return data;
  });
  const candidateMediaByItem = new Map(candidateMedia.map((row) => [row.publication_item_id, row.media_asset_id]));

  const profileIds = [...new Set(candidates.map((row) => row.profile_id))];
  const published = await rowsInChunks(profileIds, async (profilePage) => {
    const { data, error } = await supabase
      .from('publication_items')
      .select('id, profile_id, format, published_at, creation_id')
      .in('profile_id', profilePage)
      .in('format', ['story', 'reel'])
      .eq('status', 'published')
      .not('published_at', 'is', null)
      .order('published_at', { ascending: false })
      .limit(10000);
    if (error) throw error;
    return data;
  });
  if (published.length === 0) return [];

  const publishedMedia = await rowsInChunks(published.map((row) => row.id), async (itemIds) => {
    const { data, error } = await supabase
      .from('publication_item_media')
      .select('publication_item_id, media_asset_id')
      .in('publication_item_id', itemIds);
    if (error) throw error;
    return data;
  });
  const publishedById = new Map(published.map((row) => [row.id, row]));
  const previousByKey = new Map();
  for (const media of publishedMedia) {
    const item = publishedById.get(media.publication_item_id);
    if (!item) continue;
    const key = `${item.profile_id}:${item.format}:${media.media_asset_id}`;
    if (!previousByKey.has(key)) previousByKey.set(key, item);
  }

  return candidates.flatMap((candidate) => {
    const mediaAssetId = candidateMediaByItem.get(candidate.id);
    const previous = previousByKey.get(`${candidate.profile_id}:${candidate.format}:${mediaAssetId}`);
    return mediaAssetId && previous ? [{ ...candidate, media_asset_id: mediaAssetId, previous }] : [];
  });
}

async function main() {
  const itemArgument = process.argv.find((value) => value.startsWith('--item='));
  const itemId = itemArgument?.slice('--item='.length) ?? null;
  const apply = process.argv.includes('--apply');
  const includeUnpaused = process.argv.includes('--include-unpaused');
  const futureArgument = process.argv.find((value) => value.startsWith('--future-hours='));
  const futureHours = Math.min(24, Math.max(0, Number(futureArgument?.slice('--future-hours='.length) ?? 0) || 0));
  const formatArgument = process.argv.find((value) => value.startsWith('--format='));
  const requestedFormat = formatArgument?.slice('--format='.length);
  const formats = ['story', 'reel'].includes(requestedFormat) ? [requestedFormat] : ['story', 'reel'];
  const supabase = createSupabase();
  const candidates = await discoverCandidates(supabase, { includeUnpaused, futureHours, formats });
  const summary = {
    discoveredAt: new Date().toISOString(),
    matchingCandidates: candidates.length,
    byFormat: candidates.reduce((counts, row) => {
      counts[row.format] = (counts[row.format] ?? 0) + 1;
      return counts;
    }, {}),
    candidates: candidates.slice(0, 20),
  };
  if (!apply) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  if (!itemId) throw new Error('Use --item=<uuid> junto com --apply.');
  const candidate = candidates.find((row) => row.id === itemId);
  if (!candidate) throw new Error('Item não é um canário válido de mídia já publicada no mesmo perfil e formato.');

  const workerId = `direct-media-canary-${randomUUID()}`.slice(0, 120);
  const { data: claimed, error: claimError } = await supabase.rpc('claim_single_paused_publication_canary', {
    p_item_id: itemId,
    p_worker_id: workerId,
    p_lease_seconds: 300,
  });
  if (claimError) throw claimError;
  if (!claimed?.[0]) throw new Error('O item não pôde ser reclamado; nenhuma publicação foi enviada.');

  const result = await processClaimedItem(claimed[0], workerId);
  await flushZernioRequestTelemetry({ createSupabase: () => supabase });
  const { data: finalItem, error: finalError } = await supabase
    .from('publication_items')
    .select('id, batch_id, profile_id, format, status, creation_id, published_at, last_error_code, last_error_message')
    .eq('id', itemId)
    .single();
  if (finalError) throw finalError;
  console.log(JSON.stringify({ candidate, workerId, result, finalItem }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
