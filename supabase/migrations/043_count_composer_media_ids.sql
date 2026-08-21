-- Total filtrado da biblioteca do compositor. Mantém a mesma regra de uso da
-- paginação para que /postagem possa exibir "exibindo X de Y" e restantes.
create or replace function public.count_composer_media_ids(
  p_organization_id uuid,
  p_usage_filter text,
  p_group_id uuid default null,
  p_ungrouped boolean default false
)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  with media_state as (
    select
      asset.id,
      exists (
        select 1
        from public.publication_item_media link
        join public.publication_items item
          on item.id = link.publication_item_id
         and item.organization_id = link.organization_id
        where link.organization_id = p_organization_id
          and link.media_asset_id = asset.id
          and item.status in ('waiting', 'ready', 'preparing', 'publishing')
      ) as is_scheduled,
      (asset.first_published_at is not null) as is_published
    from public.media_assets asset
    where asset.organization_id = p_organization_id
      and asset.deleted_at is null
      and asset.status = 'ready'
      and public.is_organization_member(p_organization_id)
      and (
        (p_group_id is null and not p_ungrouped)
        or (p_group_id is not null and exists (
          select 1 from public.media_group_assignments assignment
          where assignment.organization_id = p_organization_id
            and assignment.media_asset_id = asset.id
            and assignment.group_id = p_group_id
        ))
        or (p_ungrouped and not exists (
          select 1 from public.media_group_assignments assignment
          where assignment.organization_id = p_organization_id
            and assignment.media_asset_id = asset.id
        ))
      )
  )
  select count(*)::integer
  from media_state state
  where (
    p_usage_filter = 'all'
    or (p_usage_filter = 'available' and not state.is_scheduled and not state.is_published)
    or (p_usage_filter = 'scheduled' and state.is_scheduled)
    or (p_usage_filter = 'published' and state.is_published)
  );
$$;

revoke all on function public.count_composer_media_ids(uuid, text, uuid, boolean) from public, anon;
grant execute on function public.count_composer_media_ids(uuid, text, uuid, boolean) to authenticated, service_role;
