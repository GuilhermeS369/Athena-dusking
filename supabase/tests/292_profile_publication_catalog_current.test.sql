begin;

select plan(9);

select has_table('public', 'profile_publication_catalog_current', 'publication catalog projection exists');
select has_function('public', 'refresh_profile_publication_catalog_current', array['uuid', 'uuid'], 'projection refresh function exists');
select has_trigger('public', 'publication_items', 'publication_items_project_profile_catalog', 'publication items project into catalog');

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
)
values ('29200000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'profiles-292@example.com', '', now(), now(), now());

insert into public.organizations (id, name, slug, created_by)
values ('29210000-0000-4000-8000-000000000001', 'Catálogo 292', 'catalogo-292', '29200000-0000-4000-8000-000000000001');

insert into public.organization_members (organization_id, user_id, role, invited_by)
values ('29210000-0000-4000-8000-000000000001', '29200000-0000-4000-8000-000000000001', 'admin', '29200000-0000-4000-8000-000000000001')
on conflict (organization_id, user_id) do nothing;

insert into public.instagram_profiles (
  id, organization_id, instagram_user_id, username,
  encrypted_access_token, status, created_by, provider
)
values ('29220000-0000-4000-8000-000000000001', '29210000-0000-4000-8000-000000000001', 'catalog-292-profile', 'catalog_292_profile', 'token', 'online', '29200000-0000-4000-8000-000000000001', 'meta_official');

insert into public.publication_batches (id, organization_id, created_by, name, status)
values ('29230000-0000-4000-8000-000000000001', '29210000-0000-4000-8000-000000000001', '29200000-0000-4000-8000-000000000001', 'Lote catálogo 292', 'queued');

insert into public.publication_items (
  id, organization_id, batch_id, profile_id, format, status,
  execute_at, idempotency_key
)
values ('29240000-0000-4000-8000-000000000001', '29210000-0000-4000-8000-000000000001', '29230000-0000-4000-8000-000000000001', '29220000-0000-4000-8000-000000000001', 'image', 'waiting', now() + interval '1 hour', 'catalog-292-idempotency-0001');

select is(
  (select count(*)::bigint from public.profile_publication_catalog_current where organization_id = '29210000-0000-4000-8000-000000000001'),
  0::bigint,
  'non-published inserts do not create unnecessary projection rows'
);

update public.publication_items
set status = 'published', published_at = '2026-08-27 14:00:00+00'
where id = '29240000-0000-4000-8000-000000000001';

select is(
  (select published_total from public.profile_publication_catalog_current where organization_id = '29210000-0000-4000-8000-000000000001' and profile_id = '29220000-0000-4000-8000-000000000001'),
  1,
  'published transition increments compact projection'
);

select is(
  (select published_image from public.profile_publication_catalog_current where organization_id = '29210000-0000-4000-8000-000000000001' and profile_id = '29220000-0000-4000-8000-000000000001'),
  1,
  'projection keeps format counters'
);

select set_config('request.jwt.claims', '{"role":"authenticated","sub":"29200000-0000-4000-8000-000000000001","email":"profiles-292@example.com"}', true);

select is(
  (select published_items from public.get_instagram_profiles_catalog_summary('29210000-0000-4000-8000-000000000001')),
  1::bigint,
  'catalog summary reads published total from projection'
);

select is(
  (select filtered_total from public.get_instagram_profiles_catalog_summary('29210000-0000-4000-8000-000000000001', null, null, null, null, 'posted')),
  1::bigint,
  'posted filter reads compact projection'
);

update public.publication_items
set status = 'removed'
where id = '29240000-0000-4000-8000-000000000001';

select is(
  (select published_total from public.profile_publication_catalog_current where organization_id = '29210000-0000-4000-8000-000000000001' and profile_id = '29220000-0000-4000-8000-000000000001'),
  0,
  'leaving published state reconciles projection back to zero'
);

select * from finish();

rollback;
