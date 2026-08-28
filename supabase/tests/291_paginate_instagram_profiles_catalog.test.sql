begin;

select plan(18);

select has_function(
  'public',
  'list_instagram_profiles_catalog_page',
  array['uuid', 'integer', 'timestamp with time zone', 'uuid', 'text', 'uuid', 'text', 'text', 'text'],
  'catalog page function exists'
);

select has_function(
  'public',
  'get_instagram_profiles_catalog_summary',
  array['uuid', 'text', 'uuid', 'text', 'text', 'text'],
  'catalog summary function exists'
);

select has_index('public', 'instagram_profiles', 'instagram_profiles_catalog_page_idx', 'catalog cursor index exists');
select has_index('public', 'instagram_profiles', 'instagram_profiles_catalog_status_page_idx', 'catalog status cursor index exists');
select has_index('public', 'profile_group_members', 'profile_group_members_group_profile_idx', 'catalog group index exists');
select has_index('public', 'instagram_profiles', 'instagram_profiles_catalog_username_trgm_idx', 'catalog username search index exists');
select has_index('public', 'instagram_profiles', 'instagram_profiles_catalog_display_name_trgm_idx', 'catalog display name search index exists');

select function_privs_are(
  'public',
  'list_instagram_profiles_catalog_page',
  array['uuid', 'integer', 'timestamp with time zone', 'uuid', 'text', 'uuid', 'text', 'text', 'text'],
  'anon',
  array[]::text[],
  'anonymous users cannot list the catalog'
);

select function_privs_are(
  'public',
  'list_instagram_profiles_catalog_page',
  array['uuid', 'integer', 'timestamp with time zone', 'uuid', 'text', 'uuid', 'text', 'text', 'text'],
  'authenticated',
  array['EXECUTE'],
  'authenticated users can list their catalog'
);

select function_privs_are(
  'public',
  'get_instagram_profiles_catalog_summary',
  array['uuid', 'text', 'uuid', 'text', 'text', 'text'],
  'authenticated',
  array['EXECUTE'],
  'authenticated users can read their catalog summary'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
)
values
  ('29100000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'profiles-291-owner@example.com', '', now(), now(), now()),
  ('29100000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'profiles-291-outsider@example.com', '', now(), now(), now());

insert into public.organizations (id, name, slug, created_by)
values
  ('29110000-0000-4000-8000-000000000001', 'Catálogo 291 A', 'catalogo-291-a', '29100000-0000-4000-8000-000000000001'),
  ('29110000-0000-4000-8000-000000000002', 'Catálogo 291 B', 'catalogo-291-b', '29100000-0000-4000-8000-000000000002');

insert into public.organization_members (organization_id, user_id, role, invited_by)
values
  ('29110000-0000-4000-8000-000000000001', '29100000-0000-4000-8000-000000000001', 'admin', '29100000-0000-4000-8000-000000000001'),
  ('29110000-0000-4000-8000-000000000002', '29100000-0000-4000-8000-000000000002', 'admin', '29100000-0000-4000-8000-000000000002')
on conflict (organization_id, user_id) do nothing;

insert into public.instagram_profiles (
  id, organization_id, instagram_user_id, username, display_name,
  encrypted_access_token, status, created_by, provider, created_at
)
select
  ('2912' || lpad(profile_number::text, 4, '0') || '-0000-4000-8000-' || lpad(profile_number::text, 12, '0'))::uuid,
  '29110000-0000-4000-8000-000000000001',
  'catalog-291-' || profile_number,
  'catalog_291_' || lpad(profile_number::text, 2, '0'),
  case when profile_number = 7 then 'Busca Especial 291' else 'Perfil ' || profile_number end,
  'token',
  case when profile_number % 3 = 0 then 'offline'::public.instagram_profile_status else 'online'::public.instagram_profile_status end,
  '29100000-0000-4000-8000-000000000001',
  'meta_official'::public.instagram_integration_provider,
  '2026-08-27 12:00:00+00'::timestamptz - make_interval(secs => profile_number)
from generate_series(1, 45) profile_number;

insert into public.instagram_profiles (
  id, organization_id, instagram_user_id, username,
  encrypted_access_token, status, created_by, provider, created_at
)
values (
  '29129999-0000-4000-8000-000000009999',
  '29110000-0000-4000-8000-000000000002',
  'catalog-291-outsider', 'catalog_291_outsider', 'token', 'online',
  '29100000-0000-4000-8000-000000000002', 'meta_official', '2026-08-27 13:00:00+00'
);

insert into public.profile_groups (id, organization_id, name, created_by)
values ('29130000-0000-4000-8000-000000000001', '29110000-0000-4000-8000-000000000001', 'Grupo Catálogo 291', '29100000-0000-4000-8000-000000000001');

insert into public.profile_group_members (organization_id, group_id, profile_id, added_by)
values ('29110000-0000-4000-8000-000000000001', '29130000-0000-4000-8000-000000000001', '29120007-0000-4000-8000-000000000007', '29100000-0000-4000-8000-000000000001');

select set_config('request.jwt.claims', '{"role":"authenticated","sub":"29100000-0000-4000-8000-000000000001","email":"profiles-291-owner@example.com"}', true);

select is(
  (select count(*)::bigint from public.list_instagram_profiles_catalog_page('29110000-0000-4000-8000-000000000001', 40)),
  40::bigint,
  'first page is bounded to forty profiles'
);

select is(
  (select bool_and(has_more) from public.list_instagram_profiles_catalog_page('29110000-0000-4000-8000-000000000001', 40)),
  true,
  'first page reports that another page exists'
);

select is(
  (with first_page as (
     select * from public.list_instagram_profiles_catalog_page('29110000-0000-4000-8000-000000000001', 40)
   ), cursor_row as (
     select created_at, id from first_page order by created_at asc, id asc limit 1
   )
   select count(*)::bigint
   from cursor_row cursor_source
   cross join lateral public.list_instagram_profiles_catalog_page(
     '29110000-0000-4000-8000-000000000001', 40, cursor_source.created_at, cursor_source.id
   )),
  5::bigint,
  'second cursor page returns only the five remaining profiles'
);

select is(
  (select count(*)::bigint from public.list_instagram_profiles_catalog_page(
    '29110000-0000-4000-8000-000000000001', 40, null, null, 'Busca Especial'
  )),
  1::bigint,
  'server search finds a display name without loading the full catalog'
);

select is(
  (select count(*)::bigint from public.list_instagram_profiles_catalog_page(
    '29110000-0000-4000-8000-000000000001', 40, null, null, null,
    '29130000-0000-4000-8000-000000000001'
  )),
  1::bigint,
  'group filter is applied in the database'
);

select is(
  (select total from public.get_instagram_profiles_catalog_summary('29110000-0000-4000-8000-000000000001')),
  45::bigint,
  'summary counts the organization without returning profile rows'
);

select is(
  (select filtered_total from public.get_instagram_profiles_catalog_summary(
    '29110000-0000-4000-8000-000000000001', null, null, 'offline'
  )),
  15::bigint,
  'summary applies the status filter'
);

select set_config('request.jwt.claims', '{"role":"authenticated","sub":"29100000-0000-4000-8000-000000000002","email":"profiles-291-outsider@example.com"}', true);

select is(
  (select count(*)::bigint from public.list_instagram_profiles_catalog_page('29110000-0000-4000-8000-000000000001', 40)),
  0::bigint,
  'catalog never exposes another organization to an outsider'
);

select * from finish();

rollback;
