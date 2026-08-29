-- Cobre as três garantias da migration 328:
--
-- A) Plano inteiro: um plano de 3 dias gera TODOS os seus slots numa sequência
--    de chamadas, sem parar na antiga parede de agora+48h. Antes da 328, o
--    último item ficava colado em now()+48h e o chunk voltava para a fila
--    indefinidamente ('horizon_waiting').
--
-- B) Janela de espaçamento: um horário que cai a menos de 10 minutos de um post
--    já marcado do mesmo perfil e formato, vindo de OUTRO lote, é pulado e
--    contabilizado como ignorado — e, principalmente, NÃO derruba o chunk com
--    23505 (que é o que trava o lote inteiro hoje).
--
-- C) Piso de 29 minutos no intervalo do lote.

begin;

select plan(12);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('32800000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'full328@example.com', '', timezone('utc', now()), timezone('utc', now()), timezone('utc', now()));

insert into public.organizations (id, name, slug, created_by)
values ('32800000-0000-0000-0000-000000000002', 'Full generation 328', 'full-generation-328', '32800000-0000-0000-0000-000000000001');

insert into public.organization_members (organization_id, user_id, role, invited_by)
values ('32800000-0000-0000-0000-000000000002', '32800000-0000-0000-0000-000000000001', 'admin', '32800000-0000-0000-0000-000000000001');

insert into public.instagram_profiles (id, organization_id, instagram_user_id, username, encrypted_access_token, status, created_by, provider, capabilities)
select gen_random_uuid(), '32800000-0000-0000-0000-000000000002', 'full-328-' || n,
  'full_328_' || n, 'synthetic-token', 'online', '32800000-0000-0000-0000-000000000001',
  'meta_official', jsonb_build_object('synthetic', true, 'n', n)
from generate_series(1, 3) n;

insert into public.media_assets (id, organization_id, uploaded_by, storage_path, original_name, mime_type, kind, size_bytes, checksum_sha256, status)
values ('32800000-0000-0000-0000-0000000000a1', '32800000-0000-0000-0000-000000000002', '32800000-0000-0000-0000-000000000001',
  'full-328/media-one.mp4', 'media-one.mp4', 'video/mp4', 'video', 1024, repeat('c', 64), 'ready');

create or replace function pg_temp.seed_plan(
  p_plan_id uuid, p_batch_id uuid, p_name text, p_profile_number integer,
  p_base_at timestamptz, p_interval integer, p_slots bigint
) returns void language plpgsql as $$
declare
  prof_id uuid;
  plan_profile_id uuid;
  chunk_id uuid;
begin
  insert into public.publication_batches (id, organization_id, created_by, name, status, review_confirmed_at)
  values (p_batch_id, '32800000-0000-0000-0000-000000000002', '32800000-0000-0000-0000-000000000001', p_name, 'queued', timezone('utc', now()));

  insert into public.bulk_publication_plans (
    id, organization_id, created_by, batch_id, request_key, request_hash, name, status, format,
    origin_type, interval_minutes, duration_days, slots_per_profile, order_mode, rotation_seed,
    profile_count, media_count, expected_publications, expected_chunks
  ) values (
    p_plan_id, '32800000-0000-0000-0000-000000000002', '32800000-0000-0000-0000-000000000001', p_batch_id,
    'full-328-request-' || replace(p_plan_id::text, '-', ''), repeat('d', 64), p_name, 'generating', 'reel',
    'ungrouped', p_interval, 3, p_slots, 'same_order', 'seed-' || p_name, 1, 1, p_slots, 1
  );

  insert into public.bulk_publication_plan_media (plan_id, organization_id, media_asset_id, ordinal, kind, storage_path)
  values (p_plan_id, '32800000-0000-0000-0000-000000000002', '32800000-0000-0000-0000-0000000000a1', 0, 'video', 'full-328/media-one.mp4');

  select id into prof_id from public.instagram_profiles
  where organization_id = '32800000-0000-0000-0000-000000000002' and (capabilities ->> 'n')::integer = p_profile_number;

  insert into public.bulk_publication_plan_profiles (
    plan_id, organization_id, profile_id, ordinal, status, schedule_base_at,
    first_execute_at, last_execute_at, total_slot_count, next_slot_index, rotation_offset
  ) values (
    p_plan_id, '32800000-0000-0000-0000-000000000002', prof_id, 0, 'generating', p_base_at,
    p_base_at + make_interval(mins => p_interval),
    p_base_at + make_interval(mins => (p_interval * p_slots)::integer),
    p_slots, 0, 0
  ) returning id into plan_profile_id;

  insert into public.bulk_publication_generation_chunks (
    plan_id, plan_profile_id, organization_id, profile_id, chunk_ordinal,
    slot_start, slot_count, next_slot_index, status
  ) values (
    p_plan_id, plan_profile_id, '32800000-0000-0000-0000-000000000002', prof_id, 0,
    0, p_slots, 0, 'queued'
  ) returning id into chunk_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- A) Plano inteiro de 3 dias, muito além da antiga parede de 48h
-- ---------------------------------------------------------------------------
-- 72 slots de 60 minutos a partir de agora: o último cai em agora + 72h, ou
-- seja, 24 horas ALÉM do antigo horizonte. Com a 326 esse chunk pararia em 47
-- slots e devolveria 'horizon_waiting' para sempre.

select pg_temp.seed_plan(
  '32800000-0000-0000-0000-0000000000b1', '32800000-0000-0000-0000-0000000000c1',
  'plano tres dias 328', 1, timezone('utc', now()), 60, 72::bigint
);

set local role service_role;

-- Drena o chunk inteiro em fatias de 100 (o teto do passo adaptativo).
do $$
declare
  chunk_id uuid;
  payload jsonb;
  guard integer := 0;
begin
  loop
    guard := guard + 1;
    exit when guard > 20;
    select id into chunk_id from public.bulk_publication_generation_chunks
    where plan_id = '32800000-0000-0000-0000-0000000000b1' and status = 'queued';
    exit when chunk_id is null;
    update public.bulk_publication_generation_chunks
    set status = 'processing', claimed_by = 'full-328-worker',
        lease_until = timezone('utc', now()) + interval '5 minutes'
    where id = chunk_id;
    payload := public.process_bulk_rotation_generation_chunk(chunk_id, 'full-328-worker', 100);
    exit when payload ->> 'status' = 'completed';
  end loop;
end $$;

select is(
  (select count(*)::integer from public.publication_items
   where batch_id = '32800000-0000-0000-0000-0000000000c1'),
  72,
  'plano de 3 dias gerou os 72 slots, sem parar no antigo horizonte de 48h'
);

select is(
  (select status from public.bulk_publication_generation_chunks
   where plan_id = '32800000-0000-0000-0000-0000000000b1'),
  'completed',
  'o chunk terminou em vez de voltar para a fila esperando o horizonte avançar'
);

select ok(
  (select max(execute_at) > timezone('utc', now()) + interval '60 hours'
   from public.publication_items where batch_id = '32800000-0000-0000-0000-0000000000c1'),
  'existe item agendado bem além de agora+48h — a parede sumiu'
);

select ok(
  (select bool_and(execute_at > timezone('utc', now()))
   from public.publication_items where batch_id = '32800000-0000-0000-0000-0000000000c1'),
  'nenhum item foi criado com horário já vencido (invariante da 326 preservada)'
);

-- ---------------------------------------------------------------------------
-- B) Janela de espaçamento entre lotes diferentes
-- ---------------------------------------------------------------------------
-- Perfil 2 já tem um Reel de OUTRO lote marcado. O plano novo produz um slot a
-- 3 minutos dele (dentro da janela de 10) e outro a 63 minutos (fora dela).

insert into public.publication_batches (id, organization_id, created_by, name, status, review_confirmed_at)
values ('32800000-0000-0000-0000-0000000000c9', '32800000-0000-0000-0000-000000000002',
  '32800000-0000-0000-0000-000000000001', 'lote preexistente 328', 'queued', timezone('utc', now()));

insert into public.publication_items (organization_id, batch_id, profile_id, format, status, execute_at, idempotency_key)
select '32800000-0000-0000-0000-000000000002', '32800000-0000-0000-0000-0000000000c9', profile.id,
  'reel', 'waiting', timezone('utc', now()) + interval '63 minutes', 'preexistente-328-1'
from public.instagram_profiles profile
where profile.organization_id = '32800000-0000-0000-0000-000000000002' and (profile.capabilities ->> 'n')::integer = 2;

-- Base = agora; intervalo 60min; 2 slots ⇒ execute_at em +60min e +120min.
-- O de +60min fica a 3 minutos do preexistente (+63min) ⇒ deve ser PULADO.
-- O de +120min fica a 57 minutos ⇒ deve ser criado.
select pg_temp.seed_plan(
  '32800000-0000-0000-0000-0000000000b2', '32800000-0000-0000-0000-0000000000c2',
  'plano com conflito 328', 2, timezone('utc', now()), 60, 2::bigint
);

update public.bulk_publication_generation_chunks
set status = 'processing', claimed_by = 'full-328-conflict', lease_until = timezone('utc', now()) + interval '5 minutes'
where plan_id = '32800000-0000-0000-0000-0000000000b2';

create temporary table conflict_result_328 on commit drop as
select public.process_bulk_rotation_generation_chunk(
  (select id from public.bulk_publication_generation_chunks where plan_id = '32800000-0000-0000-0000-0000000000b2'),
  'full-328-conflict', 100
) as payload;

select is(
  (select (payload ->> 'skippedConflictItems')::bigint from conflict_result_328),
  1::bigint,
  'o horário dentro da janela de 10 minutos foi pulado'
);

select is(
  (select (payload ->> 'status') from conflict_result_328),
  'completed',
  'o chunk CONCLUIU em vez de morrer com 23505 — o lote não trava mais'
);

select is(
  (select count(*)::integer from public.publication_items
   where batch_id = '32800000-0000-0000-0000-0000000000c2'),
  1,
  'só o horário fora da janela virou publicação'
);

select ok(
  not exists (
    select 1 from public.publication_items
    where batch_id = '32800000-0000-0000-0000-0000000000c2'
      and execute_at < timezone('utc', now()) + interval '70 minutes'
  ),
  'o horário criado é o de +120min, não o que colidia'
);

select is(
  (select ignored_items from public.bulk_publication_generation_chunks
   where plan_id = '32800000-0000-0000-0000-0000000000b2'),
  1::bigint,
  'o horário pulado ficou contabilizado como ignorado no chunk'
);

select is(
  (select ignored_slot_count from public.bulk_publication_plan_profiles
   where plan_id = '32800000-0000-0000-0000-0000000000b2'),
  1::bigint,
  'o horário pulado ficou contabilizado como ignorado no perfil do plano'
);

-- ---------------------------------------------------------------------------
-- C) Piso de 29 minutos
-- ---------------------------------------------------------------------------

select throws_ok(
  $$insert into public.bulk_publication_plans (
      organization_id, created_by, batch_id, request_key, request_hash, name, status, format,
      origin_type, interval_minutes, duration_days, slots_per_profile, order_mode, rotation_seed,
      profile_count, media_count, expected_publications, expected_chunks
    ) values (
      '32800000-0000-0000-0000-000000000002', '32800000-0000-0000-0000-000000000001',
      '32800000-0000-0000-0000-0000000000c9', 'full-328-request-piso-invalido', repeat('e', 64),
      'intervalo curto demais', 'queued', 'reel', 'ungrouped',
      28, 1, 51, 'same_order', 'seed-piso', 1, 1, 51, 1
    )$$,
  '23514',
  null,
  'intervalo de 28 minutos é recusado pelo piso'
);

select lives_ok(
  $$insert into public.bulk_publication_plans (
      organization_id, created_by, batch_id, request_key, request_hash, name, status, format,
      origin_type, interval_minutes, duration_days, slots_per_profile, order_mode, rotation_seed,
      profile_count, media_count, expected_publications, expected_chunks
    ) values (
      '32800000-0000-0000-0000-000000000002', '32800000-0000-0000-0000-000000000001',
      '32800000-0000-0000-0000-0000000000c9', 'full-328-request-piso-valido', repeat('f', 64),
      'intervalo no piso', 'queued', 'reel', 'ungrouped',
      29, 1, 49, 'same_order', 'seed-piso-ok', 1, 1, 49, 1
    )$$,
  'intervalo de 29 minutos é aceito'
);

select * from finish();

rollback;
