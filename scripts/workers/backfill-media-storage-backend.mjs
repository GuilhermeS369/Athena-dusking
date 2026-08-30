#!/usr/bin/env node
// Backfill de `media_assets.storage_backend` (migration 332).
//
// Contexto: depois que `MEDIA_STORAGE_BACKEND` virou 'r2', os uploads passaram
// a gravar só no R2, mas o filtro da galeria (`media_asset_has_storage_object`)
// só enxergava `storage.objects` do Supabase — as mídias novas sumiram da
// interface mesmo com o arquivo íntegro. A migration 332 passa a considerar
// presente o que está marcado como 'r2'; este script marca as mídias que já
// tinham sido enviadas antes dela.
//
// Só marca 'r2' o que for confirmado com HEAD no bucket do R2. Registros sem
// arquivo em nenhum dos dois backends continuam ocultos de propósito (mesma
// proteção das migrations 047/049/050) e são apenas listados no relatório.
//
// Uso:
//   node scripts/workers/backfill-media-storage-backend.mjs           # simulação
//   node scripts/workers/backfill-media-storage-backend.mjs --apply   # grava

import fs from 'node:fs';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

for (const filePath of ['.env.local', '.env.worker.deploy']) {
  if (!fs.existsSync(filePath)) continue;
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    const separator = line.indexOf('=');
    if (!line || line.startsWith('#') || separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (process.env[key]) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

const apply = process.argv.includes('--apply');
const bucket = process.env.R2_BUCKET_INSTAGRAM_MEDIA || 'instagram-media';
const PAGE_SIZE = 1000;
const CONCURRENCY = 20;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const { S3Client, HeadObjectCommand } = await import('@aws-sdk/client-s3');
const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

async function mapWithLimit(items, limit, handler) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await handler(items[index]);
    }
  }));
  return results;
}

// Paginação explícita com ordem determinística: `max_rows` do PostgREST corta
// silenciosamente qualquer select sem range (ver CLAUDE.md).
async function fetchAllAssets() {
  const assets = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('media_assets')
      .select('id, organization_id, storage_path, storage_backend, status, deleted_at, created_at')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    assets.push(...data);
    if (data.length < PAGE_SIZE) return assets;
  }
}

const assets = await fetchAllAssets();
const candidates = assets.filter((asset) => asset.storage_backend !== 'r2');
console.log(`mídias: ${assets.length} | já marcadas como r2: ${assets.length - candidates.length} | a verificar: ${candidates.length}`);

const inSupabase = await mapWithLimit(candidates, CONCURRENCY, async (asset) => {
  const { data, error } = await supabase.rpc('media_asset_has_storage_object', { p_storage_path: asset.storage_path });
  if (error) throw error;
  return Boolean(data);
});

// A migration 332 faz a função responder true para quem já está marcado como
// 'r2', então quem chega aqui como presente pode estar no Supabase ou já ter
// sido marcado por uma execução anterior — em ambos os casos não há o que fazer.
const missingInSupabase = candidates.filter((_, index) => !inSupabase[index]);
console.log(`sem objeto no Supabase Storage: ${missingInSupabase.length}`);

const inR2 = await mapWithLimit(missingInSupabase, CONCURRENCY, async (asset) => {
  try {
    await r2.send(new HeadObjectCommand({ Bucket: bucket, Key: asset.storage_path }));
    return true;
  } catch {
    return false;
  }
});

const toMark = missingInSupabase.filter((_, index) => inR2[index]);
const broken = missingInSupabase.filter((_, index) => !inR2[index]);
console.log(`  -> presentes no R2 (serão marcadas): ${toMark.length}`);
console.log(`  -> ausentes nos dois backends (permanecem ocultas): ${broken.length}`);

const perOrganization = {};
for (const asset of toMark) perOrganization[asset.organization_id] = (perOrganization[asset.organization_id] ?? 0) + 1;
console.log('por organização:', perOrganization);

const activeBroken = broken.filter((asset) => !asset.deleted_at && asset.status === 'ready');
if (activeBroken.length) {
  console.log(`atenção: ${activeBroken.length} mídias ativas sem arquivo em nenhum backend (amostra):`, activeBroken.slice(0, 10).map((asset) => asset.id));
}

if (!apply) {
  console.log('simulação: nada foi gravado. Rode de novo com --apply para aplicar.');
  process.exit(0);
}

let updated = 0;
for (let index = 0; index < toMark.length; index += 100) {
  const chunk = toMark.slice(index, index + 100);
  const { data, error } = await supabase
    .from('media_assets')
    .update({ storage_backend: 'r2' })
    .in('id', chunk.map((asset) => asset.id))
    .select('id');
  if (error) throw error;
  updated += data.length;
}
console.log(`marcadas como r2: ${updated}`);
