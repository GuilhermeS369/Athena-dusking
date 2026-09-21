import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  MAX_BULK_CAPTION_LIST_TOTAL_LENGTH,
  MAX_BULK_CAPTION_VARIANTS,
  MIN_BULK_CAPTION_VARIANTS,
} from './bulk-caption-list.ts';
import { MAX_PUBLICATION_CAPTION_LENGTH } from './composer.ts';

// Guardas de TEXTO sobre a migration 437 (lista de legendas). Não substituem o
// ensaio no banco em transação desfeita; existem para que uma migration futura ou
// um refactor não desfaçam, sem ninguém notar, o que impede item sem legenda e o
// que mantém o plano de uma legenda idêntico ao de antes.

const migrationsUrl = new URL('../../supabase/migrations/', import.meta.url);
const read = async (name: string) => (await readFile(new URL(name, migrationsUrl), 'utf8')).replace(/\r/g, '');
const migration = await read('437_bulk_caption_variants.sql');
const videoVariants = await read('436_publication_video_variants.sql');

function functionBody(sql: string, name: string) {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.notEqual(start, -1, `função ${name} ausente`);
  const open = sql.indexOf('$$', start) + 2;
  return sql.slice(open, sql.indexOf('$$', open));
}

const generator = functionBody(migration, 'process_bulk_rotation_generation_chunk');

test('o gerador é a cópia da 436 com só as duas linhas da legenda trocadas', () => {
  const original = functionBody(videoVariants, 'process_bulk_rotation_generation_chunk').split('\n');
  const current = generator.split('\n');
  const removed = original.filter((line) => !current.includes(line)).map((line) => line.trim());
  const added = current.filter((line) => !original.includes(line));
  assert.deepEqual(removed, [
    'plan_row.caption, desired.idempotency_key, plan_row.reel_cover_media_asset_id',
    'and item.caption is not distinct from plan_row.caption',
  ]);
  assert.ok(added.some((line) => line.includes('desired.caption, desired.idempotency_key, plan_row.reel_cover_media_asset_id')));
  assert.ok(added.length <= 30, `o gerador ganhou ${added.length} linhas; confira se ainda é cópia da 436`);
});

test('plano sem lista não divide por zero e usa a legenda única de sempre', () => {
  assert.equal(generator.split('nullif(plan_row.caption_variant_count, 0)').length - 1, 2);
  const choice = 'case when plan_row.caption_variant_count > 0 then caption_variant.caption else plan_row.caption end';
  assert.equal(generator.split(choice).length - 1, 2, 'desired e conferência escolhem a legenda do mesmo jeito');
  // coalesce publicaria sem legenda: plan_row.caption é null no modo lista.
  assert.ok(!/coalesce\(\s*caption_variant\.caption/.test(generator));
  assert.equal(generator.split('(plan_row.caption_variant_count = 0 or caption_variant.caption is not null)').length - 1, 2);
  assert.ok(generator.includes("errcode = 'P0001', message = 'Lista de legendas do plano incompleta"));
});

test('na conferência o join da legenda vem antes do join de itens (senão 42P01 em todo plano)', () => {
  const check = generator.slice(generator.indexOf('into materialized_count'));
  const captionJoin = check.indexOf('left join public.bulk_publication_plan_captions caption_variant');
  const itemJoin = check.indexOf('join public.publication_items item');
  assert.ok(captionJoin !== -1 && itemJoin !== -1 && captionJoin < itemJoin);
});

test('a ordem de cada perfil usa semente própria e ordinal 0 (não anda junto com a das mídias)', () => {
  const apply = functionBody(migration, 'apply_bulk_plan_caption_variants');
  assert.ok(apply.includes("bulk_rotation_v2_profile_offset(target_plan.rotation_seed || ':caption:' || profile_plan.ordinal, 0, item_count)"));
  assert.ok(apply.includes("bulk_rotation_v2_profile_step(target_plan.rotation_seed || ':caption:' || profile_plan.ordinal, 0, item_count)"));
  assert.ok(apply.includes("'Este pedido já foi criado com outra lista de legendas.'"));
});

test('a tabela quente não muda e a tabela nova é fechada para o painel', () => {
  assert.ok(!/alter table public\.publication_items\b/i.test(migration));
  assert.ok(!/create (or replace )?trigger/i.test(migration));
  assert.ok(!/function public\.claim_publication_items\(/i.test(migration));
  assert.ok(migration.includes("set lock_timeout = '10s';"));
  assert.ok(migration.includes("notify pgrst, 'reload schema';"));
  assert.match(migration, /primary key \(plan_id, ordinal\)/);
  assert.ok(migration.includes('alter table public.bulk_publication_plan_captions enable row level security;'));
  assert.ok(migration.includes('revoke all on table public.bulk_publication_plan_captions from public, anon, authenticated;'));
});

test('v4 tem grant para o painel; validação e gravação só por dentro', () => {
  for (const name of ['create_bulk_rotation_plan_v4', 'create_bulk_daily_rotation_plan_v4', 'create_bulk_sequential_rotation_plan_v4']) {
    assert.match(migration, new RegExp(`grant execute on function public\\.${name}\\([^;]*text\\[\\][^;]*\\) to authenticated, service_role;`));
    assert.ok(functionBody(migration, name).includes('perform public.assert_bulk_caption_variants(p_format, p_caption, p_caption_variants);'));
  }
  assert.ok(migration.includes('revoke all on function public.assert_bulk_caption_variants(public.publication_format, text, text[]) from public, anon, authenticated;'));
  assert.ok(migration.includes('revoke all on function public.apply_bulk_plan_caption_variants(jsonb, text[]) from public, anon, authenticated;'));
});

test('os limites do banco são os mesmos do app', () => {
  const assertBody = functionBody(migration, 'assert_bulk_caption_variants');
  assert.ok(assertBody.includes(`item_count not between ${MIN_BULK_CAPTION_VARIANTS} and ${MAX_BULK_CAPTION_VARIANTS}`));
  assert.ok(assertBody.includes(`char_length(item.caption) > ${MAX_PUBLICATION_CAPTION_LENGTH}`));
  assert.ok(assertBody.includes(`> ${MAX_BULK_CAPTION_LIST_TOTAL_LENGTH}`));
  assert.ok(migration.includes(`caption_variant_count between ${MIN_BULK_CAPTION_VARIANTS} and ${MAX_BULK_CAPTION_VARIANTS}`));
  assert.ok(migration.includes(`check (char_length(caption) between 1 and ${MAX_PUBLICATION_CAPTION_LENGTH})`));
});

// Uma cópia futura do gerador feita a partir da 436 (ou de qualquer versão antiga)
// escreveria plan_row.caption em todo item e as listas sumiriam em silêncio.
test('a migration mais nova que define o gerador continua usando a lista de legendas', async () => {
  const files = (await readdir(migrationsUrl)).filter((name) => /^\d+_.*\.sql$/.test(name)).sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
  let latest: string | null = null;
  for (const name of files) {
    if ((await read(name)).includes('create or replace function public.process_bulk_rotation_generation_chunk(')) latest = name;
  }
  assert.ok(latest && Number.parseInt(latest, 10) >= 437, `gerador mais novo: ${latest}`);
  assert.ok(functionBody(await read(latest), 'process_bulk_rotation_generation_chunk').includes('bulk_publication_plan_captions'), `${latest} redefine o gerador sem a lista de legendas`);
});
