-- Módulo X/Twitter: catálogo de mídia e grupos totalmente isolados.

create type public.twitter_media_kind as enum ('image', 'gif', 'video');
create type public.twitter_media_status as enum ('uploading', 'ready', 'failed', 'deleted');

create table public.twitter_media_assets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  storage_path text not null unique check (char_length(storage_path) between 40 and 1000),
  original_name text not null check (char_length(trim(original_name)) between 1 and 255),
  mime_type text not null check (mime_type in ('image/jpeg','image/png','image/webp','image/gif','video/mp4','video/quicktime')),
  media_kind public.twitter_media_kind not null,
  byte_size bigint not null check (byte_size between 1 and 536870912),
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  duration_ms bigint check (duration_ms is null or duration_ms >= 0),
  sha256 text check (sha256 is null or sha256 ~ '^[a-f0-9]{64}$'),
  status public.twitter_media_status not null default 'uploading',
  failure_code text,
  failure_message text,
  created_by uuid not null references auth.users (id) on delete restrict,
  deleted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (storage_path like organization_id::text || '/%'),
  check (
    (media_kind = 'image' and mime_type in ('image/jpeg','image/png','image/webp'))
    or (media_kind = 'gif' and mime_type = 'image/gif')
    or (media_kind = 'video' and mime_type in ('video/mp4','video/quicktime'))
  )
);

create index twitter_media_assets_org_status_idx
  on public.twitter_media_assets (organization_id, status, created_at desc)
  where deleted_at is null;

create table public.twitter_groups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  name text not null check (char_length(trim(name)) between 1 and 120),
  description text check (description is null or char_length(description) <= 1000),
  created_by uuid not null references auth.users (id) on delete restrict,
  deleted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index twitter_groups_org_name_active_idx
  on public.twitter_groups (organization_id, lower(name))
  where deleted_at is null;

create table public.twitter_group_members (
  organization_id uuid not null references public.organizations (id) on delete restrict,
  group_id uuid not null references public.twitter_groups (id) on delete cascade,
  profile_id uuid not null references public.twitter_profiles (id) on delete restrict,
  added_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (group_id, profile_id)
);

create index twitter_group_members_org_profile_idx
  on public.twitter_group_members (organization_id, profile_id);

create trigger twitter_media_assets_set_updated_at
before update on public.twitter_media_assets
for each row execute function public.set_updated_at();
create trigger twitter_groups_set_updated_at
before update on public.twitter_groups
for each row execute function public.set_updated_at();

create or replace function public.twitter_replace_group_members(
  p_organization_id uuid,
  p_group_id uuid,
  p_profile_ids uuid[],
  p_actor_user_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare inserted_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Apenas service_role pode substituir membros de grupo X.';
  end if;
  if not exists (
    select 1 from public.twitter_groups
    where id = p_group_id and organization_id = p_organization_id and deleted_at is null
    for update
  ) then
    raise exception using errcode = 'P0002', message = 'Grupo X não encontrado.';
  end if;
  if exists (
    select 1 from unnest(coalesce(p_profile_ids, array[]::uuid[])) requested(profile_id)
    left join public.twitter_profiles profile
      on profile.id = requested.profile_id
      and profile.organization_id = p_organization_id
      and profile.deleted_at is null
    where profile.id is null
  ) then
    raise exception using errcode = '22023', message = 'Um ou mais perfis X não pertencem à organização.';
  end if;

  delete from public.twitter_group_members where group_id = p_group_id;
  insert into public.twitter_group_members (organization_id, group_id, profile_id, added_by)
  select p_organization_id, p_group_id, requested.profile_id, p_actor_user_id
  from (select distinct unnest(coalesce(p_profile_ids, array[]::uuid[])) as profile_id) requested;
  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

alter table public.twitter_media_assets enable row level security;
alter table public.twitter_groups enable row level security;
alter table public.twitter_group_members enable row level security;

create policy twitter_media_assets_select_member
on public.twitter_media_assets for select to authenticated
using (public.is_organization_member(organization_id));
create policy twitter_groups_select_member
on public.twitter_groups for select to authenticated
using (public.is_organization_member(organization_id));
create policy twitter_group_members_select_member
on public.twitter_group_members for select to authenticated
using (public.is_organization_member(organization_id));

revoke all on table public.twitter_media_assets, public.twitter_groups, public.twitter_group_members from anon;
grant select on table public.twitter_media_assets, public.twitter_groups, public.twitter_group_members to authenticated;
grant select, insert, update, delete on table public.twitter_media_assets, public.twitter_groups, public.twitter_group_members to service_role;

revoke all on function public.twitter_replace_group_members(uuid, uuid, uuid[], uuid) from public, anon, authenticated;
grant execute on function public.twitter_replace_group_members(uuid, uuid, uuid[], uuid) to service_role;
