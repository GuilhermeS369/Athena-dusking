import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { BULK_VIDEO_VARIANT_RECIPES } from './bulk-api.ts';

// Guardas de TEXTO sobre a migration 436 e as peças que dependem dela. Não
// substituem o ensaio no banco (transação desfeita, 20/09/2026); existem para que
// uma migration futura ou um refactor não desfaçam, sem ninguém notar, as
// decisões que mantêm a fila leve e que impedem o post do arquivo original.

const read = (relative: string) => readFile(new URL(relative, import.meta.url), 'utf8');
const migration = await read('../../supabase/migrations/436_publication_video_variants.sql');
// 439 estende as tres listas de receita da 436 com a `bookend` (22/09/2026).
const bookendMigration = await read('../../supabase/migrations/439_video_variant_bookend_recipe.sql');
const sequentialMigration = await read('../../supabase/migrations/432_bulk_sequential_schedule.sql');
const publisher = await read('../../scripts/workers/publication-direct-dispatch.mjs');
const recipes = await read('../../scripts/workers/video-variant-recipes.mjs');

function functionBody(sql: string, name: string) {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.notEqual(start, -1, `função ${name} ausente`);
  const open = sql.indexOf('$$', start) + 2;
  return sql.slice(open, sql.indexOf('$$', open));
}

test('a lista de receitas é a mesma no painel, no worker e nos checks do banco', () => {
  const expected = [...BULK_VIDEO_VARIANT_RECIPES];
  assert.deepEqual(expected, ['container', 'micro', 'light', 'bookend']);
  assert.ok(recipes.includes("Object.freeze(['container', 'micro', 'light', 'bookend'])"));
  const checks = bookendMigration.match(/in \('container', 'micro', 'light', 'bookend'\)/g) ?? [];
  // coluna do plano, coluna da tabela lateral e a função que grava a receita.
  assert.equal(checks.length, 3, `esperava 3 listas de receita na 439, achei ${checks.length}`);
  assert.ok(bookendMigration.includes('revoke all on function public.apply_bulk_plan_video_variant_recipe'));
  assert.ok(!migration.includes("'visible'") && !bookendMigration.includes("'visible'"));
});

test('a tabela quente não ganha coluna, gatilho nem mudança no claim', () => {
  assert.ok(!/alter table public\.publication_items\b/i.test(migration));
  assert.ok(!/create (or replace )?trigger/i.test(migration));
  assert.ok(!/function public\.claim_publication_items\(/i.test(migration));
  assert.ok(!/function public\.expire_late_publication_items\(/i.test(migration));
});

test('a tabela lateral é PK = FK em cascata, fechada para o painel, com prova de bytes únicos', () => {
  assert.match(migration, /publication_item_id uuid primary key\s+references public\.publication_items\(id\) on delete cascade/);
  assert.match(migration, /create unique index if not exists publication_item_video_variants_unique_bytes_idx\s+on public\.publication_item_video_variants \(source_media_asset_id, checksum_sha256\)/);
  assert.ok(migration.includes('alter table public.publication_item_video_variants enable row level security;'));
  assert.ok(migration.includes('revoke all on table public.publication_item_video_variants from public, anon, authenticated;'));
});

test('RPCs do worker são só do service_role; os wrappers v3 têm grant explícito para authenticated', () => {
  for (const name of [
    'claim_publication_video_variants', 'complete_publication_video_variant', 'fail_publication_video_variant',
    'resolve_publication_preparation_for_variant', 'requeue_publication_video_variant',
    'claim_publication_video_variant_gc', 'confirm_publication_video_variant_gc',
  ]) {
    assert.ok(functionBody(migration, name).includes("auth.role() <> 'service_role'"), `${name} sem conferência de role`);
    assert.match(migration, new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon, authenticated;`));
    assert.match(migration, new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to service_role;`));
  }
  for (const name of ['create_bulk_rotation_plan_v3', 'create_bulk_daily_rotation_plan_v3', 'create_bulk_sequential_rotation_plan_v3']) {
    assert.match(migration, new RegExp(`grant execute on function public\\.${name}\\([^;]*\\) to authenticated, service_role;`));
  }
});

test('preparação e conclusão travam na mesma ordem: variante antes do item', () => {
  for (const name of ['resolve_publication_preparation_for_variant', 'complete_publication_video_variant']) {
    const body = functionBody(migration, name);
    const variantAt = body.indexOf('public.publication_item_video_variants variant');
    const itemAt = body.indexOf('update public.publication_items item');
    assert.ok(variantAt !== -1 && itemAt !== -1 && variantAt < itemAt, `${name}: ordem de trava invertida`);
  }
});

test('variante pendente bloqueia a preparação por um dia, e só o worker encurta', () => {
  const resolve = functionBody(migration, 'resolve_publication_preparation_for_variant');
  assert.ok(resolve.includes('blocked_seconds constant integer := 86400;'));
  assert.ok(resolve.includes("'preparation_variant_pending'"));
  const complete = functionBody(migration, 'complete_publication_video_variant');
  assert.ok(complete.includes("item.preparation_error_code = 'preparation_variant_pending'"));
  assert.ok(complete.includes('set next_preparation_at = resolved_now'));
});

test('o gerador é a cópia da 432 com exatamente as duas mudanças da 436', () => {
  const name = 'process_bulk_rotation_generation_chunk';
  const original = functionBody(sequentialMigration.replace(/\r/g, ''), name);
  const current = functionBody(migration.replace(/\r/g, ''), name);
  const added = current.split('\n').filter((line) => !original.split('\n').includes(line));
  const removed = original.split('\n').filter((line) => !current.split('\n').includes(line));
  assert.deepEqual(removed, [], 'nenhuma linha da 432 pode sumir');
  assert.ok(added.some((line) => line.includes('wants_video_variant boolean := false;')));
  assert.ok(added.some((line) => line.includes('), inserted_variants as (')));
  assert.ok(added.some((line) => line.includes("profile.provider = 'meta_official'")));
  assert.ok(added.length <= 25, `o gerador ganhou ${added.length} linhas; confira se ainda é cópia da 432`);
});

test('o publicador fica inerte com a chave desligada e nunca cai para o original', () => {
  assert.ok(publisher.includes("process.env.PUBLICATION_WORKER_VIDEO_VARIANTS === 'true'"));
  assert.match(publisher, /\.select\(videoVariantsEnabled\(\)/);
  const variantUrl = publisher.slice(
    publisher.indexOf('async function buildVerifiedVideoVariantUrl'),
    publisher.indexOf('export async function buildVerifiedMediaUrls'),
  );
  assert.ok(variantUrl.length > 0);
  assert.ok(!variantUrl.includes('recordAttempt('), 'sonda de variante não pode contar contra a mídia original');
  assert.ok(!variantUrl.includes('media.storage_path'), 'o caminho do original não pode aparecer no caminho da variante');
});
