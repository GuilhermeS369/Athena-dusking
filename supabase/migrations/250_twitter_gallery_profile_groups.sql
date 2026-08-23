-- A Galeria X usa os mesmos grupos dos perfis. Remove a classificação paralela
-- criada por engano em 248/249 sem misturar dados com o Instagram.

alter table public.twitter_media_group_members
  drop constraint if exists twitter_media_group_members_group_id_fkey;

-- Preserva vínculos antigos somente quando já existe um grupo de perfis X com
-- o mesmo nome na mesma organização. Grupos paralelos sem correspondente não
-- criam grupos de perfis implicitamente.
insert into public.twitter_media_group_members(
  organization_id, group_id, asset_id, added_by, created_at
)
select member.organization_id, profile_group.id, member.asset_id,
  member.added_by, member.created_at
from public.twitter_media_group_members member
join public.twitter_media_groups media_group on media_group.id=member.group_id
join public.twitter_groups profile_group
  on profile_group.organization_id=member.organization_id
 and lower(profile_group.name)=lower(media_group.name)
 and profile_group.deleted_at is null
on conflict(group_id,asset_id) do nothing;

delete from public.twitter_media_group_members member
where not exists(
  select 1 from public.twitter_groups profile_group
  where profile_group.id=member.group_id
    and profile_group.organization_id=member.organization_id
    and profile_group.deleted_at is null
);

alter table public.twitter_media_group_members
  add constraint twitter_media_group_members_group_id_fkey
  foreign key(group_id) references public.twitter_groups(id) on delete cascade;

create or replace function public.twitter_replace_media_group_members(
  p_organization_id uuid,
  p_group_id uuid,
  p_asset_ids uuid[],
  p_actor_user_id uuid
) returns integer language plpgsql security definer set search_path=public as $$
declare inserted_count integer;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception using errcode='42501'; end if;
  if not exists(
    select 1 from public.twitter_groups
    where id=p_group_id and organization_id=p_organization_id and deleted_at is null
    for update
  ) then
    raise exception using errcode='P0002',message='Grupo de perfis X não encontrado.';
  end if;
  if exists(
    select 1 from unnest(coalesce(p_asset_ids,array[]::uuid[])) requested(asset_id)
    left join public.twitter_media_assets asset
      on asset.id=requested.asset_id
     and asset.organization_id=p_organization_id
     and asset.deleted_at is null
    where asset.id is null
  ) then
    raise exception using errcode='22023',message='Uma ou mais mídias X não pertencem à organização.';
  end if;
  delete from public.twitter_media_group_members where group_id=p_group_id;
  insert into public.twitter_media_group_members(organization_id,group_id,asset_id,added_by)
  select p_organization_id,p_group_id,asset_id,p_actor_user_id
  from (select distinct unnest(coalesce(p_asset_ids,array[]::uuid[])) asset_id) requested;
  get diagnostics inserted_count=row_count;
  return inserted_count;
end;
$$;

create or replace function public.twitter_update_media_group_assignments_bulk(
  p_organization_id uuid,p_media_asset_ids uuid[],p_group_ids uuid[],p_action text,p_actor_user_id uuid
) returns table(media_asset_id uuid,group_id uuid)
language plpgsql security definer set search_path=public as $$
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception using errcode='42501'; end if;
  if p_action not in('add','remove','replace') then
    raise exception using errcode='22023',message='Ação de grupos inválida.';
  end if;
  if exists(
    select 1 from unnest(p_media_asset_ids) requested(asset_id)
    left join public.twitter_media_assets asset
      on asset.id=requested.asset_id and asset.organization_id=p_organization_id and asset.deleted_at is null
    where asset.id is null
  ) or exists(
    select 1 from unnest(p_group_ids) requested(group_id)
    left join public.twitter_groups profile_group
      on profile_group.id=requested.group_id and profile_group.organization_id=p_organization_id and profile_group.deleted_at is null
    where profile_group.id is null
  ) then
    raise exception using errcode='22023',message='Mídia ou grupo de perfis não pertence à organização.';
  end if;
  if p_action='replace' then
    delete from public.twitter_media_group_members member
    where member.organization_id=p_organization_id and member.asset_id=any(p_media_asset_ids);
  end if;
  if p_action='remove' then
    delete from public.twitter_media_group_members member
    where member.organization_id=p_organization_id
      and member.asset_id=any(p_media_asset_ids)
      and member.group_id=any(p_group_ids);
  else
    insert into public.twitter_media_group_members(organization_id,group_id,asset_id,added_by)
    select p_organization_id,group_id,asset_id,p_actor_user_id
    from unnest(p_group_ids) group_id cross join unnest(p_media_asset_ids) asset_id
    on conflict(group_id,asset_id) do nothing;
  end if;
  return query
    select member.asset_id,member.group_id
    from public.twitter_media_group_members member
    where member.organization_id=p_organization_id
      and member.asset_id=any(p_media_asset_ids);
end;
$$;

comment on table public.twitter_media_group_members is
  'Vínculo entre mídias X e os grupos de perfis X (twitter_groups).';

notify pgrst,'reload schema';
