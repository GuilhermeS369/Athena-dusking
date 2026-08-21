-- Athena Scheduler: provedor Zernio por organização e perfis Instagram multi-provider.

create type public.instagram_integration_provider as enum (
  'meta_official',
  'zernio'
);

create table public.zernio_organization_settings (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  encrypted_api_key text not null check (char_length(trim(encrypted_api_key)) between 16 and 2000),
  zernio_profile_id text check (zernio_profile_id is null or char_length(trim(zernio_profile_id)) between 1 and 160),
  status public.instagram_profile_status not null default 'no_data',
  last_checked_at timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.instagram_profiles
  add column provider public.instagram_integration_provider not null default 'meta_official',
  add column zernio_profile_id text,
  add column zernio_account_id text,
  add column zernio_account_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(zernio_account_metadata) = 'object'),
  alter column encrypted_access_token drop not null;

alter table public.instagram_profiles
  add constraint instagram_profiles_provider_credentials_check check (
    (
      provider = 'meta_official'
      and encrypted_access_token is not null
      and zernio_account_id is null
    )
    or (
      provider = 'zernio'
      and zernio_account_id is not null
    )
  );

create unique index instagram_profiles_org_zernio_account_idx
  on public.instagram_profiles (organization_id, zernio_account_id)
  where provider = 'zernio' and deleted_at is null;

create index instagram_profiles_org_provider_idx
  on public.instagram_profiles (organization_id, provider, updated_at desc)
  where deleted_at is null;

create trigger zernio_organization_settings_set_updated_at
before update on public.zernio_organization_settings
for each row execute function public.set_updated_at();

alter table public.zernio_organization_settings enable row level security;

create policy zernio_settings_select_operator
on public.zernio_organization_settings for select
to authenticated
using (public.has_organization_role(organization_id, array['admin', 'operator']::public.organization_role[]));

create policy zernio_settings_insert_admin
on public.zernio_organization_settings for insert
to authenticated
with check (
  created_by = (select auth.uid())
  and public.has_organization_role(organization_id, array['admin']::public.organization_role[])
);

create policy zernio_settings_update_admin
on public.zernio_organization_settings for update
to authenticated
using (public.has_organization_role(organization_id, array['admin']::public.organization_role[]))
with check (public.has_organization_role(organization_id, array['admin']::public.organization_role[]));

create policy zernio_settings_delete_admin
on public.zernio_organization_settings for delete
to authenticated
using (public.has_organization_role(organization_id, array['admin']::public.organization_role[]));

revoke select on public.instagram_profiles_safe from authenticated;
drop view public.instagram_profiles_safe;

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
  zernio_account_metadata,
  created_by,
  deleted_at,
  created_at,
  updated_at
from public.instagram_profiles;

create view public.zernio_organization_settings_safe
with (security_invoker = true)
as
select
  organization_id,
  true as configured,
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

grant select on public.instagram_profiles_safe to authenticated;
grant select on public.zernio_organization_settings_safe to authenticated;
grant insert, update, delete on public.zernio_organization_settings to authenticated;
