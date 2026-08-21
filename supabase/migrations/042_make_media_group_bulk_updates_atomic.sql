-- A alteração de grupos precisa ser atômica: em um "mover", uma falha ao
-- criar o destino não pode deixar a mídia sem os vínculos anteriores.
create or replace function public.update_media_group_assignments_bulk(
  p_organization_id uuid,
  p_media_asset_ids uuid[],
  p_group_ids uuid[],
  p_action text
)
returns table (
  media_asset_id uuid,
  group_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  asset_ids uuid[] := array(select distinct unnest(coalesce(p_media_asset_ids, '{}'::uuid[])));
  group_ids uuid[] := array(select distinct unnest(coalesce(p_group_ids, '{}'::uuid[])));
begin
  if not public.has_organization_role(p_organization_id, array['admin', 'operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Ação não permitida';
  end if;

  if cardinality(asset_ids) is null or cardinality(asset_ids) = 0
    or cardinality(group_ids) is null or cardinality(group_ids) = 0
    or p_action not in ('add', 'remove', 'replace') then
    raise exception using errcode = '22023', message = 'Selecione mídias, grupos e uma operação válida';
  end if;

  if (select count(*) from public.media_assets asset
      where asset.organization_id = p_organization_id
        and asset.deleted_at is null
        and asset.id = any(asset_ids)) <> cardinality(asset_ids) then
    raise exception using errcode = '22023', message = 'Uma ou mais mídias são inválidas';
  end if;

  if (select count(*) from public.profile_groups group_row
      where group_row.organization_id = p_organization_id
        and group_row.deleted_at is null
        and group_row.id = any(group_ids)) <> cardinality(group_ids) then
    raise exception using errcode = '22023', message = 'Um ou mais grupos são inválidos';
  end if;

  if p_action = 'remove' then
    delete from public.media_group_assignments assignment
    where assignment.organization_id = p_organization_id
      and assignment.media_asset_id = any(asset_ids)
      and assignment.group_id = any(group_ids);
  elsif p_action = 'replace' then
    delete from public.media_group_assignments assignment
    where assignment.organization_id = p_organization_id
      and assignment.media_asset_id = any(asset_ids);

    insert into public.media_group_assignments (organization_id, media_asset_id, group_id, assigned_by)
    select p_organization_id, asset_row.asset_id, group_row.group_id, auth.uid()
    from unnest(asset_ids) as asset_row(asset_id)
    cross join unnest(group_ids) as group_row(group_id);
  else
    insert into public.media_group_assignments (organization_id, media_asset_id, group_id, assigned_by)
    select p_organization_id, asset_row.asset_id, group_row.group_id, auth.uid()
    from unnest(asset_ids) as asset_row(asset_id)
    cross join unnest(group_ids) as group_row(group_id)
    on conflict (media_asset_id, group_id) do nothing;
  end if;

  return query
  select assignment.media_asset_id, assignment.group_id
  from public.media_group_assignments assignment
  where assignment.organization_id = p_organization_id
    and assignment.media_asset_id = any(asset_ids);
end;
$$;

revoke all on function public.update_media_group_assignments_bulk(uuid, uuid[], uuid[], text) from public, anon;
grant execute on function public.update_media_group_assignments_bulk(uuid, uuid[], uuid[], text) to authenticated, service_role;
