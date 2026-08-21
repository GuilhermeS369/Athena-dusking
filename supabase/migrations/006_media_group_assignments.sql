-- Athena Scheduler: associação de mídias da galeria a grupos.

create table public.media_group_assignments (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  media_asset_id uuid not null references public.media_assets (id) on delete cascade,
  group_id uuid not null references public.profile_groups (id) on delete cascade,
  assigned_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (media_asset_id, group_id)
);

create index media_group_assignments_group_idx
  on public.media_group_assignments (organization_id, group_id, created_at desc);

create or replace function public.enforce_media_group_assignment_organization()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.media_assets asset
    join public.profile_groups group_row on group_row.id = new.group_id
    where asset.id = new.media_asset_id
      and asset.organization_id = new.organization_id
      and group_row.organization_id = new.organization_id
      and asset.deleted_at is null
      and group_row.deleted_at is null
  ) then
    raise exception using errcode = '23514',
      message = 'Mídia e grupo devem pertencer à mesma organização ativa';
  end if;

  return new;
end;
$$;

create trigger media_group_assignments_validate_organization
before insert or update on public.media_group_assignments
for each row execute function public.enforce_media_group_assignment_organization();

alter table public.media_group_assignments enable row level security;

create policy media_group_assignments_select_member
on public.media_group_assignments for select
to authenticated
using (public.is_organization_member(organization_id));

create policy media_group_assignments_insert_operator
on public.media_group_assignments for insert
to authenticated
with check (
  assigned_by = (select auth.uid())
  and public.has_organization_role(
    organization_id,
    array['admin', 'operator']::public.organization_role[]
  )
);

create policy media_group_assignments_delete_operator
on public.media_group_assignments for delete
to authenticated
using (
  public.has_organization_role(
    organization_id,
    array['admin', 'operator']::public.organization_role[]
  )
);

revoke all on table public.media_group_assignments from anon;
grant select, insert, delete on table public.media_group_assignments to authenticated;

revoke all on function public.enforce_media_group_assignment_organization() from public;
