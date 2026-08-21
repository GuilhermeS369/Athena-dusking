-- Teste transacional do alvo ON CONFLICT usado pelo worker de analytics.
-- Executar contra banco descartável com migrations até 209.

begin;

do $$
declare
  inferable_index_exists boolean;
begin
  select exists (
    select 1
    from pg_catalog.pg_index index_row
    join pg_catalog.pg_class index_class
      on index_class.oid = index_row.indexrelid
    join pg_catalog.pg_class table_class
      on table_class.oid = index_row.indrelid
    join pg_catalog.pg_namespace namespace_row
      on namespace_row.oid = table_class.relnamespace
    where namespace_row.nspname = 'public'
      and table_class.relname = 'profile_post_analytics_snapshots'
      and index_class.relname = 'profile_post_analytics_snapshots_zernio_unique_idx'
      and index_row.indisunique
      and index_row.indisvalid
      and index_row.indpred is null
  ) into inferable_index_exists;

  if not inferable_index_exists then
    raise exception 'O índice de zernio_post_id precisa ser UNIQUE, válido e não parcial.';
  end if;
end;
$$;

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  confirmed_at, created_at, updated_at
)
values (
  '10900000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'analytics-upsert-test@example.com', '',
  now(), now(), now()
);

insert into public.organizations (id, name, slug, created_by)
values (
  '20900000-0000-4000-8000-000000000001',
  'Organização analytics upsert',
  'organizacao-analytics-upsert',
  '10900000-0000-4000-8000-000000000001'
);

insert into public.instagram_profiles (
  id, organization_id, instagram_user_id, username,
  encrypted_access_token, status, created_by, provider
)
values (
  '30900000-0000-4000-8000-000000000001',
  '20900000-0000-4000-8000-000000000001',
  'analytics-upsert-profile', 'analytics_upsert_profile',
  'token', 'online', '10900000-0000-4000-8000-000000000001', 'zernio'
);

insert into public.profile_post_analytics_snapshots (
  organization_id, profile_id, provider, zernio_post_id,
  likes, total_interactions, sync_status, raw_payload
)
values (
  '20900000-0000-4000-8000-000000000001',
  '30900000-0000-4000-8000-000000000001',
  'zernio', 'post-upsert-209', 1, 1, 'synced', '{}'
)
on conflict (organization_id, zernio_post_id)
do update set
  likes = excluded.likes,
  total_interactions = excluded.total_interactions,
  deleted_at = null;

insert into public.profile_post_analytics_snapshots (
  organization_id, profile_id, provider, zernio_post_id,
  likes, total_interactions, sync_status, raw_payload
)
values (
  '20900000-0000-4000-8000-000000000001',
  '30900000-0000-4000-8000-000000000001',
  'zernio', 'post-upsert-209', 7, 9, 'synced', '{}'
)
on conflict (organization_id, zernio_post_id)
do update set
  likes = excluded.likes,
  total_interactions = excluded.total_interactions,
  deleted_at = null;

do $$
begin
  if (
    select count(*)
    from public.profile_post_analytics_snapshots
    where organization_id = '20900000-0000-4000-8000-000000000001'
      and zernio_post_id = 'post-upsert-209'
  ) <> 1 then
    raise exception 'O upsert criou linha duplicada.';
  end if;

  if not exists (
    select 1
    from public.profile_post_analytics_snapshots
    where organization_id = '20900000-0000-4000-8000-000000000001'
      and zernio_post_id = 'post-upsert-209'
      and likes = 7
      and total_interactions = 9
  ) then
    raise exception 'O ON CONFLICT não atualizou a linha existente.';
  end if;
end;
$$;

rollback;
