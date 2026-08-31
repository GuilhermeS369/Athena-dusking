begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(10);

-- Mesmo cenario de fronteira da 344: created_at e UTC e a organizacao opera em
-- America/Sao_Paulo, entao tudo conectado das 21h em diante ja esta no dia
-- seguinte em UTC. O intervalo tem de recortar pelo dia local nas duas pontas.

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) values
  ('14500000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'range-345@example.com', '', now(), now(), now());

insert into public.organizations (id, name, slug, created_by)
values ('24500000-0000-4000-8000-000000000001', 'Intervalo 345', 'intervalo-345', '14500000-0000-4000-8000-000000000001');

insert into public.organization_members (organization_id, user_id, role, invited_by)
values ('24500000-0000-4000-8000-000000000001', '14500000-0000-4000-8000-000000000001', 'admin', '14500000-0000-4000-8000-000000000001');

insert into public.instagram_profiles (
  id, organization_id, instagram_user_id, username, encrypted_access_token, status, created_by, created_at
) values
  -- 26/08 23:30 local -> 27/08 02:30Z
  ('44500000-0000-4000-8000-000000000001', '24500000-0000-4000-8000-000000000001', 'ig-345-a', 'dia26_2330', 'token', 'online', '14500000-0000-4000-8000-000000000001', '2026-08-27T02:30:00Z'),
  -- 27/08 00:10 local -> 27/08 03:10Z
  ('44500000-0000-4000-8000-000000000002', '24500000-0000-4000-8000-000000000001', 'ig-345-b', 'dia27_0010', 'token', 'online', '14500000-0000-4000-8000-000000000001', '2026-08-27T03:10:00Z'),
  -- 27/08 21:30 local -> 28/08 00:30Z
  ('44500000-0000-4000-8000-000000000003', '24500000-0000-4000-8000-000000000001', 'ig-345-c', 'dia27_2130', 'token', 'online', '14500000-0000-4000-8000-000000000001', '2026-08-28T00:30:00Z'),
  -- 28/08 09:00 local -> 28/08 12:00Z
  ('44500000-0000-4000-8000-000000000004', '24500000-0000-4000-8000-000000000001', 'ig-345-d', 'dia28_0900', 'token', 'online', '14500000-0000-4000-8000-000000000001', '2026-08-28T12:00:00Z'),
  -- 30/08 10:00 local -> 30/08 13:00Z
  ('44500000-0000-4000-8000-000000000005', '24500000-0000-4000-8000-000000000001', 'ig-345-e', 'dia30_1000', 'token', 'online', '14500000-0000-4000-8000-000000000001', '2026-08-30T13:00:00Z');

set local role authenticated;
set local request.jwt.claim.sub = '14500000-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.email = 'range-345@example.com';

-- Intervalo fechado --------------------------------------------------------

select extensions.is(
  (select array_agg(username order by username) from public.list_instagram_profiles_catalog_page(
    '24500000-0000-4000-8000-000000000001', 40, null, null, null, null, null, null, 'all', 'recent', null,
    '2026-08-27'::date, '2026-08-28'::date)),
  array['dia27_0010', 'dia27_2130', 'dia28_0900'],
  'o intervalo 27-28 inclui as duas pontas e respeita o fuso local'
);
select extensions.is(
  (select array_agg(username order by username) from public.list_instagram_profiles_catalog_page(
    '24500000-0000-4000-8000-000000000001', 40, null, null, null, null, null, null, 'all', 'recent', null,
    '2026-08-26'::date, '2026-08-26'::date)),
  array['dia26_2330'],
  'intervalo de um dia so equivale ao dia'
);

-- Pontas abertas -------------------------------------------------------------

select extensions.is(
  (select array_agg(username order by username) from public.list_instagram_profiles_catalog_page(
    '24500000-0000-4000-8000-000000000001', 40, null, null, null, null, null, null, 'all', 'recent', null,
    '2026-08-28'::date, null)),
  array['dia28_0900', 'dia30_1000'],
  'so o inicio significa daquele dia em diante'
);
select extensions.is(
  (select array_agg(username order by username) from public.list_instagram_profiles_catalog_page(
    '24500000-0000-4000-8000-000000000001', 40, null, null, null, null, null, null, 'all', 'recent', null,
    null, '2026-08-27'::date)),
  array['dia26_2330', 'dia27_0010', 'dia27_2130'],
  'so o fim significa ate aquele dia, inclusive'
);
select extensions.is(
  (select count(*)::integer from public.list_instagram_profiles_catalog_page(
    '24500000-0000-4000-8000-000000000001', 40, null, null, null, null, null, null, 'all', 'recent', null,
    null, null)),
  5,
  'sem intervalo, o catalogo continua trazendo tudo'
);

-- Pagina, ids e resumo concordam ---------------------------------------------

select extensions.is(
  (select count(*)::integer from public.list_instagram_profiles_catalog_ids(
    '24500000-0000-4000-8000-000000000001', 2000, null, null, null, null, 'all',
    '2026-08-27'::date, '2026-08-28'::date)),
  3,
  'os ids do filtro respeitam o mesmo intervalo'
);
select extensions.is(
  (select filtered_total::integer from public.get_instagram_profiles_catalog_summary(
    '24500000-0000-4000-8000-000000000001', null, null, null, null, 'all',
    '2026-08-27'::date, '2026-08-28'::date)),
  3,
  'o total filtrado do resumo bate com os ids'
);
select extensions.is(
  (select total::integer from public.get_instagram_profiles_catalog_summary(
    '24500000-0000-4000-8000-000000000001', null, null, null, null, 'all',
    '2026-08-27'::date, '2026-08-28'::date)),
  5,
  'o total geral ignora o intervalo, como os demais contadores do topo'
);

-- Intervalo vazio e intervalo invertido --------------------------------------

select extensions.is(
  (select count(*)::integer from public.list_instagram_profiles_catalog_page(
    '24500000-0000-4000-8000-000000000001', 40, null, null, null, null, null, null, 'all', 'recent', null,
    '2026-08-29'::date, '2026-08-29'::date)),
  0,
  'dia sem adicao devolve vazio em vez de cair no filtro inteiro'
);

-- Pontas invertidas nao casam nada: quem ordena e o cliente, e o teste registra
-- que o banco nao tenta adivinhar a intencao.
select extensions.is(
  (select count(*)::integer from public.list_instagram_profiles_catalog_page(
    '24500000-0000-4000-8000-000000000001', 40, null, null, null, null, null, null, 'all', 'recent', null,
    '2026-08-28'::date, '2026-08-27'::date)),
  0,
  'intervalo invertido devolve vazio, sem inverter sozinho no banco'
);

select * from extensions.finish();
rollback;
