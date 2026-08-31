begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(10);

-- O risco deste filtro nao e o SQL, e o fuso. created_at e UTC e a organizacao
-- opera em America/Sao_Paulo (UTC-3): tudo que foi conectado das 21h em diante
-- ja esta no dia seguinte em UTC. Se o recorte for feito em UTC, o perfil some
-- do dia em que a pessoa lembra de ter adicionado — e a faixa da noite e
-- justamente quando mais se conecta conta.

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) values
  ('14400000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'created-on-344@example.com', '', now(), now(), now());

insert into public.organizations (id, name, slug, created_by)
values ('24400000-0000-4000-8000-000000000001', 'Data 344', 'data-344', '14400000-0000-4000-8000-000000000001');

insert into public.organization_members (organization_id, user_id, role, invited_by)
values ('24400000-0000-4000-8000-000000000001', '14400000-0000-4000-8000-000000000001', 'admin', '14400000-0000-4000-8000-000000000001');

-- Quatro perfis em volta da meia-noite de Sao Paulo entre 27 e 28/08/2026.
-- Em UTC (-03), 27/08 vai de 03:00Z do dia 27 ate 02:59:59Z do dia 28.
insert into public.instagram_profiles (
  id, organization_id, instagram_user_id, username, encrypted_access_token, status, created_by, created_at
) values
  -- 26/08 23:30 em Sao Paulo -> 27/08 02:30Z. Em UTC pareceria dia 27.
  ('44400000-0000-4000-8000-000000000001', '24400000-0000-4000-8000-000000000001', 'ig-344-a', 'vespera_2330', 'token', 'online', '14400000-0000-4000-8000-000000000001', '2026-08-27T02:30:00Z'),
  -- 27/08 00:10 em Sao Paulo -> 27/08 03:10Z. Primeiro do dia.
  ('44400000-0000-4000-8000-000000000002', '24400000-0000-4000-8000-000000000001', 'ig-344-b', 'inicio_0010', 'token', 'online', '14400000-0000-4000-8000-000000000001', '2026-08-27T03:10:00Z'),
  -- 27/08 21:30 em Sao Paulo -> 28/08 00:30Z. Em UTC pareceria dia 28.
  ('44400000-0000-4000-8000-000000000003', '24400000-0000-4000-8000-000000000001', 'ig-344-c', 'noite_2130', 'token', 'online', '14400000-0000-4000-8000-000000000001', '2026-08-28T00:30:00Z'),
  -- 28/08 09:00 em Sao Paulo -> 28/08 12:00Z. Fora do recorte.
  ('44400000-0000-4000-8000-000000000004', '24400000-0000-4000-8000-000000000001', 'ig-344-d', 'seguinte_0900', 'token', 'online', '14400000-0000-4000-8000-000000000001', '2026-08-28T12:00:00Z');

set local role authenticated;
set local request.jwt.claim.sub = '14400000-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.email = 'created-on-344@example.com';

-- A pagina recorta o dia local -------------------------------------------------

select extensions.is(
  (select count(*)::integer from public.list_instagram_profiles_catalog_page(
    '24400000-0000-4000-8000-000000000001', 40, null, null, null, null, null, null, 'all', 'recent', null,
    '2026-08-27'::date)),
  2,
  '27/08 no fuso da organizacao traz exatamente os dois perfis daquele dia'
);
select extensions.is(
  (select array_agg(username order by username) from public.list_instagram_profiles_catalog_page(
    '24400000-0000-4000-8000-000000000001', 40, null, null, null, null, null, null, 'all', 'recent', null,
    '2026-08-27'::date)),
  array['inicio_0010', 'noite_2130'],
  'a conta das 21h30 fica no dia 27, nao no 28'
);
select extensions.is(
  (select array_agg(username order by username) from public.list_instagram_profiles_catalog_page(
    '24400000-0000-4000-8000-000000000001', 40, null, null, null, null, null, null, 'all', 'recent', null,
    '2026-08-26'::date)),
  array['vespera_2330'],
  'a conta das 23h30 do dia 26 fica no dia 26'
);
select extensions.is(
  (select array_agg(username order by username) from public.list_instagram_profiles_catalog_page(
    '24400000-0000-4000-8000-000000000001', 40, null, null, null, null, null, null, 'all', 'recent', null,
    '2026-08-28'::date)),
  array['seguinte_0900'],
  'o dia 28 traz so o que foi adicionado no dia 28 local'
);
select extensions.is(
  (select count(*)::integer from public.list_instagram_profiles_catalog_page(
    '24400000-0000-4000-8000-000000000001', 40, null, null, null, null, null, null, 'all', 'recent', null, null)),
  4,
  'sem data, o catalogo continua trazendo tudo'
);

-- Pagina, ids e resumo precisam concordar --------------------------------------

select extensions.is(
  (select count(*)::integer from public.list_instagram_profiles_catalog_ids(
    '24400000-0000-4000-8000-000000000001', 2000, null, null, null, null, 'all', '2026-08-27'::date)),
  2,
  'os ids do filtro respeitam a mesma data'
);
select extensions.is(
  (select filtered_total::integer from public.get_instagram_profiles_catalog_summary(
    '24400000-0000-4000-8000-000000000001', null, null, null, null, 'all', '2026-08-27'::date)),
  2,
  'o total filtrado do resumo bate com os ids'
);
select extensions.is(
  (select total::integer from public.get_instagram_profiles_catalog_summary(
    '24400000-0000-4000-8000-000000000001', null, null, null, null, 'all', '2026-08-27'::date)),
  4,
  'o total geral ignora o filtro de data, como os demais contadores do topo'
);

-- Pagina, ids e resumo nao podem divergir por causa de grupos -----------------
-- A migration 018 garante um grupo por perfil, entao o left join do catalogo nao
-- duplica linha. O distinct nas tres funcoes existe para o alinhamento entre
-- filtered_total e os ids nao depender de uma restricao declarada noutro lugar.

select extensions.ok(
  exists (
    select 1 from pg_constraint
    where conname = 'profile_group_members_organization_profile_unique'
      and contype = 'u'
  ),
  'segue valendo um grupo por perfil, base do alinhamento entre resumo e ids'
);

insert into public.profile_groups (id, organization_id, name, created_by)
values ('54400000-0000-4000-8000-000000000001', '24400000-0000-4000-8000-000000000001', 'Grupo A 344', '14400000-0000-4000-8000-000000000001');
insert into public.profile_group_members (organization_id, group_id, profile_id, added_by)
values ('24400000-0000-4000-8000-000000000001', '54400000-0000-4000-8000-000000000001', '44400000-0000-4000-8000-000000000002', '14400000-0000-4000-8000-000000000001');

select extensions.is(
  (select filtered_total::integer from public.get_instagram_profiles_catalog_summary(
    '24400000-0000-4000-8000-000000000001', null, null, null, null, 'all', '2026-08-27'::date)),
  (select count(*)::integer from public.list_instagram_profiles_catalog_ids(
    '24400000-0000-4000-8000-000000000001', 2000, null, null, null, null, 'all', '2026-08-27'::date)),
  'com perfil agrupado, o total filtrado continua igual a contagem de ids'
);

select * from extensions.finish();
rollback;
