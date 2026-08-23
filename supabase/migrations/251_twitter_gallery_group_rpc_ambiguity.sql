-- Corrige a versão já publicada do vínculo entre mídia e grupo de perfis X.
-- Nomes explícitos evitam conflito com as colunas de saída da função PL/pgSQL.

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
      on asset.id=requested.asset_id
     and asset.organization_id=p_organization_id
     and asset.deleted_at is null
    where asset.id is null
  ) or exists(
    select 1 from unnest(p_group_ids) requested(group_id)
    left join public.twitter_groups profile_group
      on profile_group.id=requested.group_id
     and profile_group.organization_id=p_organization_id
     and profile_group.deleted_at is null
    where profile_group.id is null
  ) then
    raise exception using errcode='22023',message='Mídia ou grupo de perfis não pertence à organização.';
  end if;
  if p_action='replace' then
    delete from public.twitter_media_group_members member
    where member.organization_id=p_organization_id
      and member.asset_id=any(p_media_asset_ids);
  end if;
  if p_action='remove' then
    delete from public.twitter_media_group_members member
    where member.organization_id=p_organization_id
      and member.asset_id=any(p_media_asset_ids)
      and member.group_id=any(p_group_ids);
  else
    insert into public.twitter_media_group_members(organization_id,group_id,asset_id,added_by)
    select p_organization_id,requested_group.group_id,requested_asset.asset_id,p_actor_user_id
    from unnest(p_group_ids) requested_group(group_id)
    cross join unnest(p_media_asset_ids) requested_asset(asset_id)
    on conflict on constraint twitter_media_group_members_pkey do nothing;
  end if;
  return query
    select member.asset_id,member.group_id
    from public.twitter_media_group_members member
    where member.organization_id=p_organization_id
      and member.asset_id=any(p_media_asset_ids);
end;
$$;

revoke all on function public.twitter_update_media_group_assignments_bulk(uuid,uuid[],uuid[],text,uuid) from public,anon,authenticated;
grant execute on function public.twitter_update_media_group_assignments_bulk(uuid,uuid[],uuid[],text,uuid) to service_role;
notify pgrst,'reload schema';
