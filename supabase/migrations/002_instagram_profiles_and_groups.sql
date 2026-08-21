-- Athena Scheduler: perfis profissionais do Instagram e grupos multiempresa.

create type public.instagram_profile_status as enum (
  'no_data',
  'online',
  'offline',
  'reauthorization_required'
);

create type public.media_consumption_mode as enum (
  'single_use',
  'reusable'
);

create table public.instagram_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  instagram_user_id text not null check (char_length(trim(instagram_user_id)) between 1 and 80),
  username text not null check (char_length(trim(username)) between 1 and 80),
  display_name text,
  profile_picture_url text,
  account_type text,
  capabilities jsonb not null default '{}'::jsonb check (jsonb_typeof(capabilities) = 'object'),
  encrypted_access_token text not null,
  token_expires_at timestamptz,
  status public.instagram_profile_status not null default 'no_data',
  last_checked_at timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_by uuid not null references auth.users (id) on delete restrict,
  deleted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (organization_id, instagram_user_id)
);

create table public.profile_groups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (char_length(trim(name)) between 2 and 120),
  description text check (description is null or char_length(description) <= 500),
  consumption_mode public.media_consumption_mode not null default 'single_use',
  default_caption text check (default_caption is null or char_length(default_caption) <= 2200),
  created_by uuid not null references auth.users (id) on delete restrict,
  deleted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.profile_group_members (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  group_id uuid not null references public.profile_groups (id) on delete cascade,
  profile_id uuid not null references public.instagram_profiles (id) on delete cascade,
  added_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (group_id, profile_id)
);

create index instagram_profiles_org_status_idx
  on public.instagram_profiles (organization_id, status, updated_at desc)
  where deleted_at is null;

create index profile_groups_org_idx
  on public.profile_groups (organization_id, updated_at desc)
  where deleted_at is null;

create index profile_group_members_profile_idx
  on public.profile_group_members (organization_id, profile_id);

create or replace function public.enforce_group_membership_organization()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.profile_groups group_row
    join public.instagram_profiles profile_row
      on profile_row.id = new.profile_id
    where group_row.id = new.group_id
      and group_row.organization_id = new.organization_id
      and profile_row.organization_id = new.organization_id
      and group_row.deleted_at is null
      and profile_row.deleted_at is null
  ) then
    raise exception using errcode = '23514',
      message = 'Grupo e perfil devem pertencer à mesma organização ativa';
  end if;

  return new;
end;
$$;

create trigger instagram_profiles_set_updated_at
before update on public.instagram_profiles
for each row execute function public.set_updated_at();

create trigger profile_groups_set_updated_at
before update on public.profile_groups
for each row execute function public.set_updated_at();

create trigger profile_group_members_validate_organization
before insert or update on public.profile_group_members
for each row execute function public.enforce_group_membership_organization();

alter table public.instagram_profiles enable row level security;
alter table public.profile_groups enable row level security;
alter table public.profile_group_members enable row level security;

create policy instagram_profiles_select_member
on public.instagram_profiles for select
to authenticated
using (public.is_organization_member(organization_id));

create policy instagram_profiles_insert_operator
on public.instagram_profiles for insert
to authenticated
with check (
  created_by = (select auth.uid())
  and public.has_organization_role(
    organization_id,
    array['admin', 'operator']::public.organization_role[]
  )
);

create policy instagram_profiles_update_operator
on public.instagram_profiles for update
to authenticated
using (
  public.has_organization_role(
    organization_id,
    array['admin', 'operator']::public.organization_role[]
  )
)
with check (
  public.has_organization_role(
    organization_id,
    array['admin', 'operator']::public.organization_role[]
  )
);

create policy profile_groups_select_member
on public.profile_groups for select
to authenticated
using (public.is_organization_member(organization_id));

create policy profile_groups_insert_operator
on public.profile_groups for insert
to authenticated
with check (
  created_by = (select auth.uid())
  and public.has_organization_role(
    organization_id,
    array['admin', 'operator']::public.organization_role[]
  )
);

create policy profile_groups_update_operator
on public.profile_groups for update
to authenticated
using (
  public.has_organization_role(
    organization_id,
    array['admin', 'operator']::public.organization_role[]
  )
)
with check (
  public.has_organization_role(
    organization_id,
    array['admin', 'operator']::public.organization_role[]
  )
);

create policy profile_group_members_select_member
on public.profile_group_members for select
to authenticated
using (public.is_organization_member(organization_id));

create policy profile_group_members_insert_operator
on public.profile_group_members for insert
to authenticated
with check (
  added_by = (select auth.uid())
  and public.has_organization_role(
    organization_id,
    array['admin', 'operator']::public.organization_role[]
  )
);

create policy profile_group_members_delete_operator
on public.profile_group_members for delete
to authenticated
using (
  public.has_organization_role(
    organization_id,
    array['admin', 'operator']::public.organization_role[]
  )
);

revoke all on function public.enforce_group_membership_organization() from public;
