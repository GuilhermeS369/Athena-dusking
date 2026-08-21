-- Athena Scheduler: múltiplas contas/API keys Zernio por organização.

create table public.zernio_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  label text not null check (char_length(trim(label)) between 2 and 80),
  encrypted_api_key text not null check (char_length(trim(encrypted_api_key)) between 16 and 2000),
  zernio_profile_id text check (zernio_profile_id is null or char_length(trim(zernio_profile_id)) between 1 and 160),
  status public.instagram_profile_status not null default 'no_data',
  balance_cents integer not null default 0,
  balance_currency text not null default 'USD' check (char_length(trim(balance_currency)) between 3 and 8),
  supported_platforms text[] not null default array['instagram']::text[],
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  last_checked_at timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_sync_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_by uuid not null references auth.users (id) on delete restrict,
  deleted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index zernio_connections_org_label_active_idx
  on public.zernio_connections (organization_id, lower(label))
  where deleted_at is null;

create index zernio_connections_org_active_idx
  on public.zernio_connections (organization_id, updated_at desc)
  where deleted_at is null;

create trigger zernio_connections_set_updated_at
before update on public.zernio_connections
for each row execute function public.set_updated_at();

alter table public.zernio_connections enable row level security;

create policy zernio_connections_select_operator
on public.zernio_connections for select
to authenticated
using (public.has_organization_role(organization_id, array['admin', 'operator']::public.organization_role[]));

create policy zernio_connections_insert_admin
on public.zernio_connections for insert
to authenticated
with check (
  created_by = (select auth.uid())
  and public.has_organization_role(organization_id, array['admin']::public.organization_role[])
);

create policy zernio_connections_update_admin
on public.zernio_connections for update
to authenticated
using (public.has_organization_role(organization_id, array['admin']::public.organization_role[]))
with check (public.has_organization_role(organization_id, array['admin']::public.organization_role[]));

create policy zernio_connections_delete_admin
on public.zernio_connections for delete
to authenticated
using (public.has_organization_role(organization_id, array['admin']::public.organization_role[]));

alter table public.instagram_profiles
  add column zernio_connection_id uuid references public.zernio_connections (id) on delete set null;

insert into public.zernio_connections (
  organization_id,
  label,
  encrypted_api_key,
  zernio_profile_id,
  status,
  last_checked_at,
  last_success_at,
  last_failure_at,
  last_error_code,
  last_error_message,
  created_by,
  created_at,
  updated_at
)
select
  organization_id,
  'Conta Zernio principal',
  encrypted_api_key,
  zernio_profile_id,
  status,
  last_checked_at,
  last_success_at,
  last_failure_at,
  last_error_code,
  last_error_message,
  created_by,
  created_at,
  updated_at
from public.zernio_organization_settings;

update public.instagram_profiles profile
set zernio_connection_id = connection.id
from public.zernio_connections connection
where profile.organization_id = connection.organization_id
  and profile.provider = 'zernio'
  and profile.zernio_connection_id is null
  and (
    profile.zernio_profile_id = connection.zernio_profile_id
    or profile.zernio_profile_id is null
    or connection.zernio_profile_id is null
  );

create index instagram_profiles_org_zernio_connection_idx
  on public.instagram_profiles (organization_id, zernio_connection_id)
  where provider = 'zernio' and deleted_at is null;

drop view if exists public.instagram_profiles_safe;

create view public.instagram_profiles_safe
with (security_invoker = true)
as
select
  id,
  organization_id,
  instagram_user_id,
  username,
  display_name,
  profile_picture_url,
  account_type,
  capabilities,
  token_expires_at,
  status,
  last_checked_at,
  last_success_at,
  last_failure_at,
  last_error_code,
  last_error_message,
  provider,
  zernio_profile_id,
  zernio_account_id,
  zernio_connection_id,
  zernio_account_metadata,
  created_by,
  deleted_at,
  created_at,
  updated_at
from public.instagram_profiles;

create view public.zernio_connections_safe
with (security_invoker = true)
as
select
  connection.id,
  connection.organization_id,
  connection.label,
  true as configured,
  connection.zernio_profile_id,
  connection.status,
  connection.balance_cents,
  connection.balance_currency,
  connection.supported_platforms,
  connection.last_checked_at,
  connection.last_success_at,
  connection.last_failure_at,
  connection.last_sync_at,
  connection.last_error_code,
  connection.last_error_message,
  connection.created_by,
  connection.deleted_at,
  connection.created_at,
  connection.updated_at,
  coalesce((
    select count(*)::integer
    from public.instagram_profiles profile
    where profile.organization_id = connection.organization_id
      and profile.provider = 'zernio'
      and profile.zernio_connection_id = connection.id
      and profile.deleted_at is null
  ), 0) as instagram_profile_count,
  jsonb_build_object(
    'instagram', coalesce((
      select count(*)::integer
      from public.instagram_profiles profile
      where profile.organization_id = connection.organization_id
        and profile.provider = 'zernio'
        and profile.zernio_connection_id = connection.id
        and profile.deleted_at is null
    ), 0),
    'tiktok', 0,
    'youtube', 0
  ) as platform_counts
from public.zernio_connections connection;

grant select on public.instagram_profiles_safe to authenticated;
grant select on public.zernio_connections_safe to authenticated;
grant insert, update, delete on public.zernio_connections to authenticated;

grant select (zernio_connection_id)
on table public.instagram_profiles
to authenticated;

grant select (
  id,
  organization_id,
  label,
  zernio_profile_id,
  status,
  balance_cents,
  balance_currency,
  supported_platforms,
  metadata,
  last_checked_at,
  last_success_at,
  last_failure_at,
  last_sync_at,
  last_error_code,
  last_error_message,
  created_by,
  deleted_at,
  created_at,
  updated_at
)
on table public.zernio_connections
to authenticated;

revoke select (encrypted_api_key)
on table public.zernio_connections
from authenticated;
