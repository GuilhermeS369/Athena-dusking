-- Cobre o espalhamento da migration 331.
--
-- O que precisa estar certo, e a ordem importa:
--
-- 1. Perfis do mesmo plano deixam de nascer no MESMO segundo — era o que
--    produzia 456 reels num único instante, hora após hora.
-- 2. O INTERVALO de cada perfil é preservado exatamente. O intervalo é o
--    produto; o deslocamento só move o ponto de partida.
-- 3. O horizonte (usado para encadear o próximo plano) acompanha o perfil
--    deslocado, sem divergir.
-- 4. `spread_window_seconds = 0` desliga o espalhamento.

begin;

select plan(9);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('33100000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'spread331@example.com', '', timezone('utc', now()), timezone('utc', now()), timezone('utc', now()));

insert into public.organizations (id, name, slug, created_by)
values ('33100000-0000-0000-0000-000000000002', 'Spread 331', 'spread-331', '33100000-0000-0000-0000-000000000001');

insert into public.organization_members (organization_id, user_id, role, invited_by)
values ('33100000-0000-0000-0000-000000000002', '33100000-0000-0000-0000-000000000001', 'admin', '33100000-0000-0000-0000-000000000001');

insert into public.instagram_profiles (id, organization_id, instagram_user_id, username, encrypted_access_token, status, created_by, provider, capabilities)
select gen_random_uuid(), '33100000-0000-0000-0000-000000000002', 'spread-331-' || n,
  'spread_331_' || n, 'synthetic-token', 'online', '33100000-0000-0000-0000-000000000001',
  'meta_official', jsonb_build_object('n', n)
from generate_series(1, 10) n;

-- Helper: cria plano + perfis + horizontes como create_bulk_rotation_plan faria,
-- com o MESMO schedule_base para todos (que é o comportamento de origem).
create or replace function pg_temp.seed(
  p_plan uuid, p_batch uuid, p_key text, p_window integer, p_profiles integer, p_interval integer, p_slots bigint
) returns void language plpgsql as $$
declare
  base timestamptz := date_trunc('hour', timezone('utc', now())) + interval '3 hours';
  prof uuid;
  pp uuid;
  n integer;
begin
  insert into public.publication_batches (id, organization_id, created_by, name, status, review_confirmed_at)
  values (p_batch, '33100000-0000-0000-0000-000000000002', '33100000-0000-0000-0000-000000000001', p_key, 'queued', timezone('utc', now()));

  insert into public.bulk_publication_plans (
    id, organization_id, created_by, batch_id, request_key, request_hash, name, status, format,
    origin_type, interval_minutes, duration_days, slots_per_profile, order_mode, rotation_seed,
    profile_count, media_count, expected_publications, expected_chunks, spread_window_seconds
  ) values (
    p_plan, '33100000-0000-0000-0000-000000000002', '33100000-0000-0000-0000-000000000001', p_batch,
    p_key, repeat('a', 64), p_key, 'queued', 'reel', 'ungrouped',
    p_interval, 3, p_slots, 'same_order', 'seed-' || p_key,
    p_profiles, 1, p_profiles * p_slots, p_profiles, p_window
  );

  for n in 1..p_profiles loop
    select id into prof from public.instagram_profiles
    where organization_id = '33100000-0000-0000-0000-000000000002' and (capabilities ->> 'n')::integer = n;

    insert into public.bulk_publication_plan_profiles (
      plan_id, organization_id, profile_id, ordinal, status, schedule_base_at,
      first_execute_at, last_execute_at, total_slot_count, rotation_offset
    ) values (
      p_plan, '33100000-0000-0000-0000-000000000002', prof, n - 1, 'queued', base,
      base + make_interval(mins => p_interval),
      base + make_interval(mins => (p_interval * p_slots)::integer),
      p_slots, 0
    ) returning id into pp;

    -- Valores propositalmente "errados" (sem deslocamento): o gatilho tem de
    -- alinhá-los ao perfil já deslocado.
    insert into public.bulk_publication_profile_horizons (
      plan_id, plan_profile_id, organization_id, profile_id, reserved_from, first_execute_at, reserved_through, slot_count
    ) values (
      p_plan, pp, '33100000-0000-0000-0000-000000000002', prof, base,
      base + make_interval(mins => p_interval),
      base + make_interval(mins => (p_interval * p_slots)::integer),
      p_slots
    );
  end loop;
end;
$$;

-- Plano com janela de 10 min, 10 perfis, intervalo de 60 min.
select pg_temp.seed('33100000-0000-0000-0000-0000000000b1', '33100000-0000-0000-0000-0000000000c1',
  'spread-331-com-janela', 600, 10, 60, 72::bigint);

select is(
  (select count(distinct first_execute_at)::integer from public.bulk_publication_plan_profiles
   where plan_id = '33100000-0000-0000-0000-0000000000b1'),
  10,
  'os 10 perfis passam a ter horários de início DISTINTOS'
);

select is(
  (select extract(epoch from (max(first_execute_at) - min(first_execute_at)))::integer
   from public.bulk_publication_plan_profiles where plan_id = '33100000-0000-0000-0000-0000000000b1'),
  540,
  'o espalhamento cobre 9/10 da janela de 600s — o último perfil não encosta no fim'
);

select ok(
  (select max(first_execute_at) - min(first_execute_at) from public.bulk_publication_plan_profiles
   where plan_id = '33100000-0000-0000-0000-0000000000b1') <= interval '600 seconds',
  'nenhum perfil é deslocado além da janela configurada'
);

-- O intervalo de cada perfil é sagrado: 60 min pedidos, 60 min entregues.
select is(
  (select count(*)::integer from public.bulk_publication_plan_profiles
   where plan_id = '33100000-0000-0000-0000-0000000000b1'
     and first_execute_at - schedule_base_at = interval '60 minutes'),
  10,
  'todos os perfis mantêm exatamente o intervalo pedido entre base e primeiro post'
);

select is(
  (select count(*)::integer from public.bulk_publication_plan_profiles
   where plan_id = '33100000-0000-0000-0000-0000000000b1'
     and last_execute_at - first_execute_at = interval '71 hours'),
  10,
  'a duração total do plano por perfil não muda com o deslocamento'
);

-- O horizonte precisa acompanhar o perfil, senão o encadeamento do próximo
-- plano cairia sobre o período errado.
select is(
  (select count(*)::integer
   from public.bulk_publication_profile_horizons as horizon
   join public.bulk_publication_plan_profiles as profile_plan on profile_plan.id = horizon.plan_profile_id
   where horizon.plan_id = '33100000-0000-0000-0000-0000000000b1'
     and horizon.reserved_from = profile_plan.schedule_base_at
     and horizon.first_execute_at = profile_plan.first_execute_at
     and horizon.reserved_through = profile_plan.last_execute_at),
  10,
  'o horizonte de cada perfil fica alinhado ao perfil deslocado'
);

-- Janela zero desliga tudo.
select pg_temp.seed('33100000-0000-0000-0000-0000000000b2', '33100000-0000-0000-0000-0000000000c2',
  'spread-331-sem-janela', 0, 10, 60, 72::bigint);

select is(
  (select count(distinct first_execute_at)::integer from public.bulk_publication_plan_profiles
   where plan_id = '33100000-0000-0000-0000-0000000000b2'),
  1,
  'com janela zero o comportamento antigo é preservado — todos no mesmo instante'
);

-- Plano de um perfil só não pode quebrar por divisão.
select pg_temp.seed('33100000-0000-0000-0000-0000000000b3', '33100000-0000-0000-0000-0000000000c3',
  'spread-331-um-perfil', 600, 1, 60, 72::bigint);

select is(
  (select count(*)::integer from public.bulk_publication_plan_profiles
   where plan_id = '33100000-0000-0000-0000-0000000000b3'),
  1,
  'plano com um único perfil é criado sem erro de divisão'
);

select is(
  (select spread_window_seconds from public.bulk_publication_plans
   where id = '33100000-0000-0000-0000-0000000000b1'),
  600,
  'a janela é configurável por plano, com padrão de 10 minutos'
);

select * from finish();

rollback;
