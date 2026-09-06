begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(8);

-- O recorte por app precisa valer nas tres funcoes do catalogo. Se so a pagina
-- filtrasse, "selecionar todos deste filtro" apagaria perfis de outro app.

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) values
  ('14190000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'app-419@example.com', '', now(), now(), now());

insert into public.organizations (id, name, slug, created_by)
values ('24190000-0000-4000-8000-000000000001', 'App 419', 'app-419', '14190000-0000-4000-8000-000000000001');

insert into public.organization_members (organization_id, user_id, role, invited_by)
values ('24190000-0000-4000-8000-000000000001', '14190000-0000-4000-8000-000000000001', 'admin', '14190000-0000-4000-8000-000000000001');

insert into public.meta_apps (id, organization_id, label, app_id, encrypted_app_secret, created_by)
values
  ('34190000-0000-4000-8000-000000000001', '24190000-0000-4000-8000-000000000001', 'App A', '100000000000001', 'segredo-de-teste-419-a', '14190000-0000-4000-8000-000000000001'),
  ('34190000-0000-4000-8000-000000000002', '24190000-0000-4000-8000-000000000001', 'App B', '100000000000002', 'segredo-de-teste-419-b', '14190000-0000-4000-8000-000000000001');

-- Dois perfis no app A, um no B, e um sem app -- a conexao legada da credencial
-- global, que a migration 366 deixou com meta_app_id nulo de proposito.
insert into public.instagram_profiles (
  id, organization_id, instagram_user_id, username, encrypted_access_token, status, created_by, meta_app_id
) values
  ('44190000-0000-4000-8000-000000000001', '24190000-0000-4000-8000-000000000001', 'ig-419-a1', 'app_a_um', 'token', 'online', '14190000-0000-4000-8000-000000000001', '34190000-0000-4000-8000-000000000001'),
  ('44190000-0000-4000-8000-000000000002', '24190000-0000-4000-8000-000000000001', 'ig-419-a2', 'app_a_dois', 'token', 'online', '14190000-0000-4000-8000-000000000001', '34190000-0000-4000-8000-000000000001'),
  ('44190000-0000-4000-8000-000000000003', '24190000-0000-4000-8000-000000000001', 'ig-419-b1', 'app_b_um', 'token', 'online', '14190000-0000-4000-8000-000000000001', '34190000-0000-4000-8000-000000000002'),
  ('44190000-0000-4000-8000-000000000004', '24190000-0000-4000-8000-000000000001', 'ig-419-g1', 'sem_app', 'token', 'online', '14190000-0000-4000-8000-000000000001', null);

set local role authenticated;
set local request.jwt.claim.sub = '14190000-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.email = 'app-419@example.com';

-- Pagina ----------------------------------------------------------------------

select extensions.is(
  (select array_agg(username order by username) from public.list_instagram_profiles_catalog_page(
    '24190000-0000-4000-8000-000000000001', 40, null, null, null, null, null, null, 'all', 'recent', null,
    null, null, '34190000-0000-4000-8000-000000000001'::uuid)),
  array['app_a_dois', 'app_a_um'],
  'o filtro por app devolve so os perfis conectados por ele'
);
select extensions.is(
  (select array_agg(username order by username) from public.list_instagram_profiles_catalog_page(
    '24190000-0000-4000-8000-000000000001', 40, null, null, null, null, null, null, 'all', 'recent', null,
    null, null, '34190000-0000-4000-8000-000000000002'::uuid)),
  array['app_b_um'],
  'trocar de app troca o conjunto inteiro'
);
select extensions.is(
  (select count(*)::integer from public.list_instagram_profiles_catalog_page(
    '24190000-0000-4000-8000-000000000001', 40, null, null, null, null, null, null, 'all', 'recent', null,
    null, null, null)),
  4,
  'sem app escolhido, o catalogo continua trazendo tudo -- inclusive o legado sem app'
);

-- O recorte se combina com os filtros que ja existiam, em vez de substitui-los.
select extensions.is(
  (select array_agg(username order by username) from public.list_instagram_profiles_catalog_page(
    '24190000-0000-4000-8000-000000000001', 40, null, null, 'dois', null, null, null, 'all', 'recent', null,
    null, null, '34190000-0000-4000-8000-000000000001'::uuid)),
  array['app_a_dois'],
  'app e busca se somam em vez de um anular o outro'
);
select extensions.is(
  (select count(*)::integer from public.list_instagram_profiles_catalog_page(
    '24190000-0000-4000-8000-000000000001', 40, null, null, 'app_b', null, null, null, 'all', 'recent', null,
    null, null, '34190000-0000-4000-8000-000000000001'::uuid)),
  0,
  'busca de um app dentro do recorte de outro nao casa nada'
);

-- Pagina, ids e resumo concordam ---------------------------------------------

select extensions.is(
  (select count(*)::integer from public.list_instagram_profiles_catalog_ids(
    '24190000-0000-4000-8000-000000000001', 2000, null, null, null, null, 'all',
    null, null, '34190000-0000-4000-8000-000000000001'::uuid)),
  2,
  'os ids do filtro respeitam o mesmo app'
);
select extensions.is(
  (select filtered_total::integer from public.get_instagram_profiles_catalog_summary(
    '24190000-0000-4000-8000-000000000001', null, null, null, null, 'all',
    null, null, '34190000-0000-4000-8000-000000000001'::uuid)),
  2,
  'o total filtrado do resumo bate com os ids'
);
select extensions.is(
  (select total::integer from public.get_instagram_profiles_catalog_summary(
    '24190000-0000-4000-8000-000000000001', null, null, null, null, 'all',
    null, null, '34190000-0000-4000-8000-000000000001'::uuid)),
  4,
  'o total geral ignora o app, como os demais contadores do topo'
);

select * from extensions.finish();
rollback;
