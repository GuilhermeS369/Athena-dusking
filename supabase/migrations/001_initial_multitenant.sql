-- Athena Scheduler: base multiempresa.
-- Execute esta migração no SQL Editor do Supabase antes de ativar as rotas protegidas.

create extension if not exists pgcrypto;

create type public.organization_role as enum ('admin', 'operator', 'viewer');

create table public.user_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  timezone text not null default 'America/Sao_Paulo' check (timezone = 'America/Sao_Paulo'),
  created_by uuid not null references auth.users (id) on delete restrict,
  deleted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.organization_members (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.organization_role not null default 'viewer',
  invited_by uuid references auth.users (id) on delete set null,
  joined_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, user_id)
);

create table public.organization_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  email text not null check (char_length(trim(email)) between 3 and 320),
  role public.organization_role not null default 'operator',
  token_hash text not null unique,
  invited_by uuid not null references auth.users (id) on delete restrict,
  accepted_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default timezone('utc', now()),
  check (accepted_at is null or accepted_at <= expires_at)
);

create index organization_members_user_idx on public.organization_members (user_id, organization_id);
create index organization_invitations_org_idx on public.organization_invitations (organization_id, expires_at);
create unique index organizations_active_slug_idx on public.organizations (slug) where deleted_at is null;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create trigger user_profiles_set_updated_at
before update on public.user_profiles
for each row execute function public.set_updated_at();

create trigger organizations_set_updated_at
before update on public.organizations
for each row execute function public.set_updated_at();

create trigger organization_members_set_updated_at
before update on public.organization_members
for each row execute function public.set_updated_at();

create or replace function public.is_organization_member(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_members member
    join public.organizations organization_row
      on organization_row.id = member.organization_id
    where member.organization_id = target_organization_id
      and member.user_id = (select auth.uid())
      and organization_row.deleted_at is null
  );
$$;

create or replace function public.has_organization_role(
  target_organization_id uuid,
  allowed_roles public.organization_role[]
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_members member
    join public.organizations organization_row
      on organization_row.id = member.organization_id
    where member.organization_id = target_organization_id
      and member.user_id = (select auth.uid())
      and member.role = any (allowed_roles)
      and organization_row.deleted_at is null
  );
$$;

create or replace function public.create_organization(
  organization_name text,
  organization_slug text
)
returns public.organizations
language plpgsql
security definer
set search_path = public
as $$
declare
  created_organization public.organizations;
  current_user_id uuid := (select auth.uid());
begin
  if current_user_id is null then
    raise exception using errcode = '42501', message = 'Autenticação necessária';
  end if;

  insert into public.organizations (name, slug, created_by)
  values (trim(organization_name), lower(trim(organization_slug)), current_user_id)
  returning * into created_organization;

  insert into public.organization_members (organization_id, user_id, role, invited_by)
  values (created_organization.id, current_user_id, 'admin', current_user_id);

  return created_organization;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_profiles (user_id, display_name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

alter table public.user_profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.organization_invitations enable row level security;

create policy user_profiles_select_self
on public.user_profiles for select
to authenticated
using (user_id = (select auth.uid()));

create policy user_profiles_update_self
on public.user_profiles for update
to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

create policy organizations_select_member
on public.organizations for select
to authenticated
using (public.is_organization_member(id));

create policy organizations_update_admin
on public.organizations for update
to authenticated
using (public.has_organization_role(id, array['admin']::public.organization_role[]))
with check (public.has_organization_role(id, array['admin']::public.organization_role[]));

create policy organization_members_select_member
on public.organization_members for select
to authenticated
using (public.is_organization_member(organization_id));

create policy organization_members_insert_admin
on public.organization_members for insert
to authenticated
with check (public.has_organization_role(organization_id, array['admin']::public.organization_role[]));

create policy organization_members_update_admin
on public.organization_members for update
to authenticated
using (public.has_organization_role(organization_id, array['admin']::public.organization_role[]))
with check (public.has_organization_role(organization_id, array['admin']::public.organization_role[]));

create policy organization_members_delete_admin
on public.organization_members for delete
to authenticated
using (public.has_organization_role(organization_id, array['admin']::public.organization_role[]));

create policy invitations_select_admin
on public.organization_invitations for select
to authenticated
using (public.has_organization_role(organization_id, array['admin']::public.organization_role[]));

create policy invitations_insert_admin
on public.organization_invitations for insert
to authenticated
with check (
  invited_by = (select auth.uid())
  and public.has_organization_role(organization_id, array['admin']::public.organization_role[])
);

create policy invitations_update_admin
on public.organization_invitations for update
to authenticated
using (public.has_organization_role(organization_id, array['admin']::public.organization_role[]))
with check (public.has_organization_role(organization_id, array['admin']::public.organization_role[]));

revoke all on function public.is_organization_member(uuid) from public;
grant execute on function public.is_organization_member(uuid) to authenticated;
revoke all on function public.has_organization_role(uuid, public.organization_role[]) from public;
grant execute on function public.has_organization_role(uuid, public.organization_role[]) to authenticated;
revoke all on function public.create_organization(text, text) from public;
grant execute on function public.create_organization(text, text) to authenticated;
