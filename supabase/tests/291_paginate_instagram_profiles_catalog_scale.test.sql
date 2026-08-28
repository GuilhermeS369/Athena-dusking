begin;

select plan(5);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
)
values ('29190000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'profiles-291-scale@example.com', '', now(), now(), now());

insert into public.organizations (id, name, slug, created_by)
values ('29191000-0000-4000-8000-000000000001', 'Catálogo 291 Escala', 'catalogo-291-escala', '29190000-0000-4000-8000-000000000001');

insert into public.organization_members (organization_id, user_id, role, invited_by)
values ('29191000-0000-4000-8000-000000000001', '29190000-0000-4000-8000-000000000001', 'admin', '29190000-0000-4000-8000-000000000001')
on conflict (organization_id, user_id) do nothing;

insert into public.instagram_profiles (
  id, organization_id, instagram_user_id, username, display_name,
  encrypted_access_token, status, created_by, provider, created_at
)
select
  gen_random_uuid(),
  '29191000-0000-4000-8000-000000000001',
  'catalog-scale-' || profile_number,
  'catalog_scale_' || lpad(profile_number::text, 4, '0'),
  'Perfil de escala ' || profile_number,
  'token',
  case
    when profile_number % 20 = 0 then 'reauthorization_required'::public.instagram_profile_status
    when profile_number % 5 = 0 then 'offline'::public.instagram_profile_status
    else 'online'::public.instagram_profile_status
  end,
  '29190000-0000-4000-8000-000000000001',
  'meta_official'::public.instagram_integration_provider,
  '2026-08-27 12:00:00+00'::timestamptz - make_interval(secs => profile_number)
from generate_series(1, 2000) profile_number;

select set_config('request.jwt.claims', '{"role":"authenticated","sub":"29190000-0000-4000-8000-000000000001","email":"profiles-291-scale@example.com"}', true);

select is(
  (select count(*)::bigint from public.list_instagram_profiles_catalog_page('29191000-0000-4000-8000-000000000001', 40)),
  40::bigint,
  'two-thousand-profile catalog still returns only forty rows'
);

select is(
  (select count(distinct id)::bigint from public.list_instagram_profiles_catalog_page('29191000-0000-4000-8000-000000000001', 40)),
  40::bigint,
  'first page contains no duplicate profile'
);

select is(
  (select total from public.get_instagram_profiles_catalog_summary('29191000-0000-4000-8000-000000000001')),
  2000::bigint,
  'compact summary sees all two thousand profiles'
);

select is(
  (select filtered_total from public.get_instagram_profiles_catalog_summary(
    '29191000-0000-4000-8000-000000000001', 'catalog_scale_1999'
  )),
  1::bigint,
  'indexed search narrows two thousand profiles to one result'
);

select is(
  (select filtered_total from public.get_instagram_profiles_catalog_summary(
    '29191000-0000-4000-8000-000000000001', null, null, null, 'error'
  )),
  100::bigint,
  'error situation counter is evaluated in the database'
);

select * from finish();

rollback;
