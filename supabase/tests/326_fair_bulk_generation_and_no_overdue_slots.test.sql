-- Cobre as duas correções da migration 326:
--
-- A) Justiça no claim: com três planos ativos (um antigo com muitos chunks e
--    dois recém-criados), uma única chamada com limite 3 precisa devolver um
--    chunk de CADA plano. Com a ordenação antiga (`order by plan.created_at`)
--    os três chunks viriam todos do plano mais antigo, que é exatamente a
--    inanição que travou os agendamentos de 29/08/2026.
--
-- B) Nunca materializar slot vencido: um chunk cujo cursor aponta para slots
--    cujo execute_at já passou precisa avançar o cursor, contar os slots como
--    ignorados e criar publication_items SOMENTE para os horários futuros.
--    Um chunk 100% vencido precisa terminar sem criar item nenhum.

begin;

select plan(15);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('32600000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'fair326@example.com', '', timezone('utc', now()), timezone('utc', now()), timezone('utc', now()));

insert into public.organizations (id, name, slug, created_by)
values ('32600000-0000-0000-0000-000000000002', 'Fair generation 326', 'fair-generation-326', '32600000-0000-0000-0000-000000000001');

insert into public.organization_members (organization_id, user_id, role, invited_by)
values ('32600000-0000-0000-0000-000000000002', '32600000-0000-0000-0000-000000000001', 'admin', '32600000-0000-0000-0000-000000000001');

-- 6 perfis online: 4 para o plano antigo, 1 para cada plano novo.
insert into public.instagram_profiles (id, organization_id, instagram_user_id, username, encrypted_access_token, status, created_by, provider, capabilities)
select gen_random_uuid(), '32600000-0000-0000-0000-000000000002', 'fair-326-' || n,
  'fair_326_' || n, 'synthetic-token', 'online', '32600000-0000-0000-0000-000000000001',
  'meta_official', jsonb_build_object('synthetic', true, 'n', n)
from generate_series(1, 6) n;

insert into public.media_assets (id, organization_id, uploaded_by, storage_path, original_name, mime_type, kind, size_bytes, checksum_sha256, status)
values ('32600000-0000-0000-0000-0000000000a1', '32600000-0000-0000-0000-000000000002', '32600000-0000-0000-0000-000000000001',
  'fair-326/media-one.mp4', 'media-one.mp4', 'video/mp4', 'video', 1024,
  repeat('a', 64), 'ready');

-- Helper: cria plano + lote + perfis do plano + chunks.
create or replace function pg_temp.seed_plan(
  p_plan_id uuid, p_batch_id uuid, p_name text, p_created_at timestamptz,
  p_profile_numbers integer[], p_base_at timestamptz, p_interval integer,
  p_slots bigint, p_next_slot bigint, p_generated bigint
) returns void language plpgsql as $$
declare
  n integer;
  ord bigint := 0;
  prof_id uuid;
  plan_profile_id uuid;
begin
  insert into public.publication_batches (id, organization_id, created_by, name, status, review_confirmed_at)
  values (p_batch_id, '32600000-0000-0000-0000-000000000002', '32600000-0000-0000-0000-000000000001', p_name, 'queued', timezone('utc', now()));

  insert into public.bulk_publication_plans (
    id, organization_id, created_by, batch_id, request_key, request_hash, name, status, format,
    origin_type, interval_minutes, duration_days, slots_per_profile, order_mode, rotation_seed,
    profile_count, media_count, expected_publications, generated_publications, expected_chunks, created_at
  ) values (
    p_plan_id, '32600000-0000-0000-0000-000000000002', '32600000-0000-0000-0000-000000000001', p_batch_id,
    'fair-326-request-' || replace(p_plan_id::text, '-', ''), repeat('b', 64), p_name, 'generating', 'reel',
    'ungrouped', p_interval, 3, p_slots, 'same_order', 'seed-' || p_name,
    array_length(p_profile_numbers, 1), 1, array_length(p_profile_numbers, 1) * p_slots, p_generated,
    array_length(p_profile_numbers, 1), p_created_at
  );

  insert into public.bulk_publication_plan_media (plan_id, organization_id, media_asset_id, ordinal, kind, storage_path)
  values (p_plan_id, '32600000-0000-0000-0000-000000000002', '32600000-0000-0000-0000-0000000000a1', 0, 'video', 'fair-326/media-one.mp4');

  foreach n in array p_profile_numbers loop
    select id into prof_id from public.instagram_profiles
    where organization_id = '32600000-0000-0000-0000-000000000002' and (capabilities ->> 'n')::integer = n;

    insert into public.bulk_publication_plan_profiles (
      plan_id, organization_id, profile_id, ordinal, status, schedule_base_at,
      first_execute_at, last_execute_at, total_slot_count, next_slot_index,
      generated_slot_count, rotation_offset
    ) values (
      p_plan_id, '32600000-0000-0000-0000-000000000002', prof_id, ord, 'generating', p_base_at,
      p_base_at + make_interval(mins => p_interval), p_base_at + make_interval(mins => (p_interval * p_slots)::integer),
      p_slots, p_next_slot, p_next_slot, 0
    ) returning id into plan_profile_id;

    insert into public.bulk_publication_generation_chunks (
      plan_id, plan_profile_id, organization_id, profile_id, chunk_ordinal,
      slot_start, slot_count, next_slot_index, status, generated_items
    ) values (
      p_plan_id, plan_profile_id, '32600000-0000-0000-0000-000000000002', prof_id, ord,
      0, p_slots, p_next_slot, 'queued', p_next_slot
    );

    ord := ord + 1;
  end loop;
end;
$$;

-- Plano ANTIGO com 4 perfis (4 chunks), já com progresso.
select pg_temp.seed_plan(
  '32600000-0000-0000-0000-0000000000b1', '32600000-0000-0000-0000-0000000000c1',
  'plano antigo 326', timezone('utc', now()) - interval '10 hours',
  array[1, 2, 3, 4], timezone('utc', now()) - interval '10 hours', 60, 40::bigint, 5::bigint, 20::bigint
);
-- Plano NOVO 1, ainda sem nada gerado.
select pg_temp.seed_plan(
  '32600000-0000-0000-0000-0000000000b2', '32600000-0000-0000-0000-0000000000c2',
  'plano novo A 326', timezone('utc', now()) - interval '2 hours',
  array[5], timezone('utc', now()) - interval '2 hours', 60, 40::bigint, 0::bigint, 0::bigint
);
-- Plano NOVO 2, ainda sem nada gerado.
select pg_temp.seed_plan(
  '32600000-0000-0000-0000-0000000000b3', '32600000-0000-0000-0000-0000000000c3',
  'plano novo B 326', timezone('utc', now()) - interval '1 hour',
  array[6], timezone('utc', now()) - interval '1 hour', 60, 40::bigint, 0::bigint, 0::bigint
);

set local role service_role;

-- ---------------------------------------------------------------------------
-- A) Justiça entre planos
-- ---------------------------------------------------------------------------

create temporary table claimed_326 on commit drop as
select * from public.claim_bulk_rotation_generation_chunks('fair-326-worker', 3, 300, 3);

select is(
  (select count(*)::integer from claimed_326),
  3,
  'claim com limite 3 devolve 3 chunks'
);

select is(
  (select count(distinct plan_id)::integer from claimed_326),
  3,
  'os 3 chunks vêm de 3 planos DIFERENTES (rodízio, não prioridade absoluta por idade)'
);

select ok(
  exists (select 1 from claimed_326 where plan_id = '32600000-0000-0000-0000-0000000000b2'),
  'o plano novo A (zero gerado) recebeu um chunk na mesma rodada que o plano antigo'
);

select ok(
  exists (select 1 from claimed_326 where plan_id = '32600000-0000-0000-0000-0000000000b3'),
  'o plano novo B (zero gerado) recebeu um chunk na mesma rodada que o plano antigo'
);

-- Os planos sem nada gerado furam a fila: vêm antes do plano antigo.
select is(
  (select count(*)::integer from claimed_326 c
   where c.plan_id in ('32600000-0000-0000-0000-0000000000b2', '32600000-0000-0000-0000-0000000000b3')),
  2,
  'os dois planos famintos (generated_publications = 0) estão entre os 3 primeiros'
);

-- ---------------------------------------------------------------------------
-- B) Nunca materializar slot vencido
-- ---------------------------------------------------------------------------

-- Plano cuja base ficou 5h no passado com intervalo de 60min: os slots 0..3
-- (execute_at = base + 1h .. base + 4h) já venceram; o slot 4 (base + 5h) é o
-- primeiro no presente/futuro.
select pg_temp.seed_plan(
  '32600000-0000-0000-0000-0000000000b4', '32600000-0000-0000-0000-0000000000c4',
  'plano vencido 326', timezone('utc', now()) - interval '30 minutes',
  array[1], timezone('utc', now()) - interval '5 hours 10 minutes', 60, 10::bigint, 0::bigint, 0::bigint
);
-- O perfil 1 já pertence ao plano antigo; usa o perfil 2 para não colidir na
-- unicidade (plan_id, profile_id) não é problema (planos distintos), mas o
-- gatilho de vaga única por (perfil, execute_at) sim — perfis distintos evitam.
update public.bulk_publication_plan_profiles set profile_id = (
  select id from public.instagram_profiles
  where organization_id = '32600000-0000-0000-0000-000000000002' and (capabilities ->> 'n')::integer = 2)
where plan_id = '32600000-0000-0000-0000-0000000000b4';
update public.bulk_publication_generation_chunks set profile_id = (
  select id from public.instagram_profiles
  where organization_id = '32600000-0000-0000-0000-000000000002' and (capabilities ->> 'n')::integer = 2)
where plan_id = '32600000-0000-0000-0000-0000000000b4';

create temporary table overdue_claim_326 on commit drop as
select * from public.claim_bulk_rotation_generation_chunks('fair-326-worker-overdue', 1, 300, 3);

select is(
  (select count(*)::integer from overdue_claim_326 where plan_id = '32600000-0000-0000-0000-0000000000b4'),
  1,
  'o plano vencido (zero gerado) é reivindicado imediatamente'
);

create temporary table overdue_result_326 on commit drop as
select public.process_bulk_rotation_generation_chunk(
  (select id from overdue_claim_326 limit 1), 'fair-326-worker-overdue', 3
) as payload;

select is(
  (select (payload ->> 'skippedOverdueItems')::bigint from overdue_result_326),
  5::bigint,
  'os 5 slots já vencidos foram pulados, não materializados'
);

select is(
  (select (payload ->> 'nextSlotIndex')::bigint from overdue_result_326),
  8::bigint,
  'cursor avançou para 5 (primeiro slot futuro) + 3 slots do passo adaptativo'
);

select is(
  (select count(*)::integer from public.publication_items
   where batch_id = '32600000-0000-0000-0000-0000000000c4'),
  3,
  'foram criados exatamente 3 itens (o passo adaptativo), nenhum a mais'
);

select ok(
  not exists (
    select 1 from public.publication_items
    where batch_id = '32600000-0000-0000-0000-0000000000c4'
      and execute_at < timezone('utc', now())
  ),
  'NENHUM item criado tem execute_at no passado'
);

select is(
  (select ignored_items from public.bulk_publication_generation_chunks
   where plan_id = '32600000-0000-0000-0000-0000000000b4'),
  5::bigint,
  'os slots vencidos foram contabilizados como ignorados no chunk'
);

select is(
  (select ignored_slot_count from public.bulk_publication_plan_profiles
   where plan_id = '32600000-0000-0000-0000-0000000000b4'),
  5::bigint,
  'os slots vencidos foram contabilizados como ignorados no perfil do plano'
);

select is(
  (select generated_slot_count from public.bulk_publication_plan_profiles
   where plan_id = '32600000-0000-0000-0000-0000000000b4'),
  3::bigint,
  'generated_slot_count conta só os itens realmente criados, não os pulados'
);

-- Chunk 100% vencido: base 20h atrás, intervalo 60min, apenas 5 slots
-- (execute_at máximo = base + 5h, ainda 15h no passado).
select pg_temp.seed_plan(
  '32600000-0000-0000-0000-0000000000b5', '32600000-0000-0000-0000-0000000000c5',
  'plano todo vencido 326', timezone('utc', now()) - interval '20 minutes',
  array[3], timezone('utc', now()) - interval '20 hours', 60, 5::bigint, 0::bigint, 0::bigint
);

select is(
  (
    select (public.process_bulk_rotation_generation_chunk(
      (select id from public.claim_bulk_rotation_generation_chunks('fair-326-worker-dead', 5, 300, 3)
       where plan_id = '32600000-0000-0000-0000-0000000000b5' limit 1),
      'fair-326-worker-dead', 3
    ) ->> 'status')
  ),
  'completed',
  'chunk cujos slots venceram por completo termina sem publicar nada'
);

select is(
  (select count(*)::integer from public.publication_items
   where batch_id = '32600000-0000-0000-0000-0000000000c5'),
  0,
  'plano totalmente vencido não criou nenhum publication_item'
);

select * from finish();

rollback;
