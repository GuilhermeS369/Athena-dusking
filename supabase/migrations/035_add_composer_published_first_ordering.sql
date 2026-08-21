-- Mantém a ordenação "mídias usadas primeiro" estável entre páginas do
-- compositor. O cursor existente identifica a mídia anterior; a função usa
-- esse registro para saber em qual parte da ordenação a próxima página começa.
create or replace function public.list_composer_media_ids_ordered(
  p_organization_id uuid,
  p_usage_filter text,
  p_group_id uuid default null,
  p_ungrouped boolean default false,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null,
  p_limit integer default 31,
  p_prioritize_published boolean default false
)
returns table (
  media_asset_id uuid,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with media_state as (
    select
      asset.id,
      asset.created_at,
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
  ),
  filtered_media as (
    select *
    from media_state state
    where p_usage_filter = 'all'
      or (p_usage_filter = 'available' and not state.is_scheduled and not state.is_published)
      or (p_usage_filter = 'scheduled' and state.is_scheduled)
      or (p_usage_filter = 'published' and state.is_published)
  ),
  cursor_state as (
    select state.is_published
    from filtered_media state
    where state.created_at = p_cursor_created_at
      and state.id = p_cursor_id
  )
  select state.id as media_asset_id, state.created_at
  from filtered_media state
  where p_cursor_created_at is null
    or (
      not p_prioritize_published
      and (state.created_at < p_cursor_created_at
        or (state.created_at = p_cursor_created_at and state.id < p_cursor_id))
    )
    or (
      p_prioritize_published
      and (
        state.is_published < coalesce((select is_published from cursor_state), false)
        or (
          state.is_published = coalesce((select is_published from cursor_state), false)
          and (state.created_at < p_cursor_created_at
            or (state.created_at = p_cursor_created_at and state.id < p_cursor_id))
        )
      )
    )
  order by
    case when p_prioritize_published then state.is_published else false end desc,
    state.created_at desc,
    state.id desc
  limit greatest(1, least(p_limit, 101));
$$;

revoke all on function public.list_composer_media_ids_ordered(uuid, text, uuid, boolean, timestamptz, uuid, integer, boolean) from public, anon;
grant execute on function public.list_composer_media_ids_ordered(uuid, text, uuid, boolean, timestamptz, uuid, integer, boolean) to authenticated, service_role;
