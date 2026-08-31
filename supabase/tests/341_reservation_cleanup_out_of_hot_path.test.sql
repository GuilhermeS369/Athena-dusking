-- Cobre a migration 341: as leituras da tabela de reservas passam a ignorar
-- linha vencida por conta própria, em vez de depender de um delete no caminho
-- crítico.
--
-- O teste que mais importa é o primeiro. Antes da 341, a checagem de reentrância
-- não filtrava por `expires_at`: uma reserva vencida do MESMO item devolvia
-- `allowed = true` imediatamente, PULANDO todas as verificações — espaçamento,
-- limite diário e limite por minuto. Enquanto o delete rodava a cada chamada
-- isso não aparecia; ao tirar o delete, viraria um furo silencioso.

begin;

select plan(7);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('34100000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'reserva341@example.com', '', timezone('utc', now()), timezone('utc', now()), timezone('utc', now()));

insert into public.organizations (id, name, slug, created_by)
values ('34100000-0000-0000-0000-000000000002', 'Reserva 341', 'reserva-341', '34100000-0000-0000-0000-000000000001');

insert into public.organization_members (organization_id, user_id, role, invited_by)
values ('34100000-0000-0000-0000-000000000002', '34100000-0000-0000-0000-000000000001', 'admin', '34100000-0000-0000-0000-000000000001');

insert into public.instagram_profiles (id, organization_id, instagram_user_id, username, encrypted_access_token, status, created_by, provider)
values
  ('34100000-0000-0000-0000-00000000000a', '34100000-0000-0000-0000-000000000002', 'reserva-341-a', 'reserva_341_a', 'synthetic-token', 'online', '34100000-0000-0000-0000-000000000001', 'meta_official'),
  ('34100000-0000-0000-0000-00000000000b', '34100000-0000-0000-0000-000000000002', 'reserva-341-b', 'reserva_341_b', 'synthetic-token', 'online', '34100000-0000-0000-0000-000000000001', 'meta_official');

insert into public.publication_batches (id, organization_id, created_by, name, status, review_confirmed_at)
values ('34100000-0000-0000-0000-000000000004', '34100000-0000-0000-0000-000000000002',
  '34100000-0000-0000-0000-000000000001', 'Lote 341', 'processing', timezone('utc', now()));

set local role service_role;
select set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);

create or replace function pg_temp.item_sob_lease(p_id uuid, p_profile uuid, p_key text)
returns void language plpgsql as $$
begin
  insert into public.publication_items (
    id, organization_id, batch_id, profile_id, format, status, execute_at,
    idempotency_key, claimed_by, lease_until
  ) values (
    p_id, '34100000-0000-0000-0000-000000000002', '34100000-0000-0000-0000-000000000004',
    p_profile, 'reel', 'preparing', timezone('utc', now()) - interval '1 minute',
    p_key, 'reserva-341-worker', timezone('utc', now()) + interval '10 minutes'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. O FURO PRINCIPAL: reserva VENCIDA do proprio item nao pode dar passe livre
-- ---------------------------------------------------------------------------
-- Publicação recente do mesmo perfil e formato: o espaçamento DEVE barrar.
insert into public.publication_items (
  organization_id, batch_id, profile_id, format, status, execute_at, idempotency_key, published_at
) values (
  '34100000-0000-0000-0000-000000000002', '34100000-0000-0000-0000-000000000004',
  '34100000-0000-0000-0000-00000000000a', 'reel', 'published',
  timezone('utc', now()) - interval '5 minutes', 'reserva-341-publicado-recente',
  timezone('utc', now()) - interval '2 minutes'
);

select pg_temp.item_sob_lease('34100000-0000-0000-0000-0000000000c1', '34100000-0000-0000-0000-00000000000a', 'reserva-341-com-reserva-vencida');

-- Reserva do PRÓPRIO item, já vencida há 10 minutos.
insert into public.publication_dispatch_rate_reservations (publication_item_id, organization_id, profile_id, provider, expires_at)
values ('34100000-0000-0000-0000-0000000000c1', '34100000-0000-0000-0000-000000000002',
  '34100000-0000-0000-0000-00000000000a', 'meta_official', timezone('utc', now()) - interval '10 minutes');

create temporary table r341_vencida on commit drop as
select * from public.reserve_publication_dispatch_capacity('34100000-0000-0000-0000-0000000000c1', 'reserva-341-worker');

select is(
  (select allowed from r341_vencida),
  false,
  'reserva VENCIDA do próprio item não dá passe livre — as checagens continuam valendo'
);

select is(
  (select reason from r341_vencida),
  'profile_min_interval',
  'e a checagem que barra é a de espaçamento, provando que a função não saiu por reentrância'
);

-- ---------------------------------------------------------------------------
-- 2. Reserva VIVA do proprio item continua sendo reentrancia legitima
-- ---------------------------------------------------------------------------
select pg_temp.item_sob_lease('34100000-0000-0000-0000-0000000000c2', '34100000-0000-0000-0000-00000000000b', 'reserva-341-com-reserva-viva');

insert into public.publication_dispatch_rate_reservations (publication_item_id, organization_id, profile_id, provider, expires_at)
values ('34100000-0000-0000-0000-0000000000c2', '34100000-0000-0000-0000-000000000002',
  '34100000-0000-0000-0000-00000000000b', 'meta_official', timezone('utc', now()) + interval '5 minutes');

select is(
  (select allowed from public.reserve_publication_dispatch_capacity('34100000-0000-0000-0000-0000000000c2', 'reserva-341-worker')),
  true,
  'reserva VIVA do próprio item continua sendo reentrância — mesmo item repetindo a tentativa'
);

-- ---------------------------------------------------------------------------
-- 3. A limpeza saiu do caminho critico: linha vencida SOBREVIVE a chamada
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::integer from public.publication_dispatch_rate_reservations
   where publication_item_id = '34100000-0000-0000-0000-0000000000c1'),
  1,
  'a reserva vencida NÃO é apagada pela chamada — a limpeza saiu do caminho crítico'
);

-- ---------------------------------------------------------------------------
-- 4. A limpeza periodica funciona, e so remove o que venceu
-- ---------------------------------------------------------------------------
select ok(
  (select public.purge_expired_publication_dispatch_reservations(5000)) >= 1,
  'a limpeza periódica remove reserva vencida'
);

select is(
  (select count(*)::integer from public.publication_dispatch_rate_reservations
   where publication_item_id = '34100000-0000-0000-0000-0000000000c2'),
  1,
  'e não toca na reserva viva'
);

-- ---------------------------------------------------------------------------
-- 5. Somente service_role limpa
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', '34100000-0000-0000-0000-000000000001', 'role', 'authenticated'
)::text, true);

select throws_matching(
  $$select public.purge_expired_publication_dispatch_reservations(10)$$,
  'permission denied for function',
  'usuário logado não consegue executar a limpeza'
);

select * from finish();

rollback;
