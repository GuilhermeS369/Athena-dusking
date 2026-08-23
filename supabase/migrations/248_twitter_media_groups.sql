-- Origens reutilizáveis da galeria X. Isoladas dos grupos de perfis e do Instagram.

create table if not exists public.twitter_media_groups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  name text not null check (char_length(trim(name)) between 1 and 120),
  description text check (description is null or char_length(description) <= 1000),
  created_by uuid not null references auth.users(id) on delete restrict,
  deleted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists twitter_media_groups_org_name_active_idx
  on public.twitter_media_groups(organization_id, lower(name)) where deleted_at is null;

create table if not exists public.twitter_media_group_members (
  organization_id uuid not null references public.organizations(id) on delete restrict,
  group_id uuid not null references public.twitter_media_groups(id) on delete cascade,
  asset_id uuid not null references public.twitter_media_assets(id) on delete restrict,
  added_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  primary key(group_id, asset_id)
);

create index if not exists twitter_media_group_members_org_asset_idx
  on public.twitter_media_group_members(organization_id, asset_id);

drop trigger if exists twitter_media_groups_set_updated_at on public.twitter_media_groups;
create trigger twitter_media_groups_set_updated_at before update on public.twitter_media_groups
for each row execute function public.set_updated_at();

create or replace function public.twitter_replace_media_group_members(
  p_organization_id uuid,
  p_group_id uuid,
  p_asset_ids uuid[],
  p_actor_user_id uuid
) returns integer language plpgsql security definer set search_path=public as $$
declare inserted_count integer;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception using errcode='42501'; end if;
  if not exists(select 1 from public.twitter_media_groups where id=p_group_id and organization_id=p_organization_id and deleted_at is null for update) then
    raise exception using errcode='P0002',message='Grupo de mídia X não encontrado.';
  end if;
  if exists(
    select 1 from unnest(coalesce(p_asset_ids,array[]::uuid[])) requested(asset_id)
    left join public.twitter_media_assets asset on asset.id=requested.asset_id and asset.organization_id=p_organization_id and asset.deleted_at is null
    where asset.id is null
  ) then raise exception using errcode='22023',message='Uma ou mais mídias X não pertencem à organização.'; end if;
  delete from public.twitter_media_group_members where group_id=p_group_id;
  insert into public.twitter_media_group_members(organization_id,group_id,asset_id,added_by)
  select p_organization_id,p_group_id,asset_id,p_actor_user_id from (select distinct unnest(coalesce(p_asset_ids,array[]::uuid[])) asset_id) requested;
  get diagnostics inserted_count=row_count;
  return inserted_count;
end;
$$;

alter table public.twitter_media_groups enable row level security;
alter table public.twitter_media_group_members enable row level security;
drop policy if exists twitter_media_groups_select_member on public.twitter_media_groups;
create policy twitter_media_groups_select_member on public.twitter_media_groups for select to authenticated using(public.is_organization_member(organization_id));
drop policy if exists twitter_media_group_members_select_member on public.twitter_media_group_members;
create policy twitter_media_group_members_select_member on public.twitter_media_group_members for select to authenticated using(public.is_organization_member(organization_id));
revoke all on table public.twitter_media_groups,public.twitter_media_group_members from anon;
grant select on table public.twitter_media_groups,public.twitter_media_group_members to authenticated;
grant select,insert,update,delete on table public.twitter_media_groups,public.twitter_media_group_members to service_role;
revoke all on function public.twitter_replace_media_group_members(uuid,uuid,uuid[],uuid) from public,anon,authenticated;
grant execute on function public.twitter_replace_media_group_members(uuid,uuid,uuid[],uuid) to service_role;

create or replace function public.twitter_bulk_profile_format_summary(p_organization_id uuid)
returns table(
  profile_id uuid,
  text_count bigint,image_count bigint,gif_count bigint,video_count bigint,pending_count bigint,blocking_count bigint,last_execute_at timestamptz,
  published_text_count bigint,published_image_count bigint,published_gif_count bigint,published_video_count bigint
) language sql stable security definer set search_path=public as $$
  select item.profile_id,
    count(*) filter(where item.status in('ready','retry','claimed','outcome_unknown') and item.media_set_client_key is null)::bigint,
    count(*) filter(where item.status in('ready','retry','claimed','outcome_unknown') and media_set.media_kind='images')::bigint,
    count(*) filter(where item.status in('ready','retry','claimed','outcome_unknown') and media_set.media_kind='gif')::bigint,
    count(*) filter(where item.status in('ready','retry','claimed','outcome_unknown') and media_set.media_kind='video')::bigint,
    count(*) filter(where item.status in('ready','retry','claimed','outcome_unknown'))::bigint,
    count(*) filter(where item.status in('claimed','processing','outcome_unknown'))::bigint,
    max(greatest(item.execute_at,coalesce(item.next_attempt_at,item.execute_at))) filter(where item.status in('ready','retry','claimed','outcome_unknown')),
    count(*) filter(where item.status='published' and item.media_set_client_key is null)::bigint,
    count(*) filter(where item.status='published' and media_set.media_kind='images')::bigint,
    count(*) filter(where item.status='published' and media_set.media_kind='gif')::bigint,
    count(*) filter(where item.status='published' and media_set.media_kind='video')::bigint
  from public.twitter_publication_items item
  left join public.twitter_program_media_sets media_set on media_set.program_id=item.program_id and media_set.client_key=item.media_set_client_key
  where item.organization_id=p_organization_id and item.status in('ready','retry','claimed','outcome_unknown','published')
  group by item.profile_id;
$$;
revoke all on function public.twitter_bulk_profile_format_summary(uuid) from public,anon,authenticated;
grant execute on function public.twitter_bulk_profile_format_summary(uuid) to service_role;
notify pgrst,'reload schema';
