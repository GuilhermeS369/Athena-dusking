-- Listagem da galeria com um único filtro de situação. Remove a necessidade
-- de separar a tela em abas de "disponíveis" e "postados" e mantém a
-- paginação/c contagem calculadas no banco com os mesmos filtros.

create or replace function public.list_gallery_media_ids(
  p_organization_id uuid,
  p_situation_filter text default 'all',
  p_type_filter text default 'all',
  p_group_id uuid default null,
  p_ungrouped boolean default false,
  p_search text default '',
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null,
  p_limit integer default 31
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
      asset.status,
      (asset.first_published_at is not null) as is_published,
      exists (
        select 1
        from public.publication_item_media link
        join public.publication_items item
          on item.id = link.publication_item_id
         and item.organization_id = link.organization_id
        where link.organization_id = p_organization_id
          and link.media_asset_id = asset.id
          and item.status in ('waiting', 'ready', 'preparing', 'publishing')
      ) as is_scheduled
    from public.media_assets asset
    where asset.organization_id = p_organization_id
      and asset.deleted_at is null
      and public.is_organization_member(p_organization_id)
      and (p_type_filter = 'all' or asset.kind::text = p_type_filter)
      and (coalesce(nullif(trim(p_search), ''), '') = '' or asset.original_name ilike ('%' || replace(replace(replace(trim(p_search), '\\', '\\\\'), '%', '\%'), '_', '\_') || '%') escape '\')
      and (
        (p_group_id is null and not p_ungrouped)
        or (p_group_id is not null and exists (
          select 1
          from public.media_group_assignments assignment
          where assignment.organization_id = p_organization_id
            and assignment.media_asset_id = asset.id
            and assignment.group_id = p_group_id
        ))
        or (p_ungrouped and not exists (
          select 1
          from public.media_group_assignments assignment
          where assignment.organization_id = p_organization_id
            and assignment.media_asset_id = asset.id
        ))
      )
  )
  select state.id as media_asset_id, state.created_at
  from media_state state
  where (
    p_situation_filter = 'all'
    or (p_situation_filter = 'schedulable' and state.status = 'ready' and not state.is_published and not state.is_scheduled)
    or (p_situation_filter = 'unposted' and not state.is_published and not state.is_scheduled)
    or (p_situation_filter = 'scheduled' and state.is_scheduled)
    or (p_situation_filter = 'posted' and state.is_published)
    or (p_situation_filter = 'posted_scheduled' and state.is_published and state.is_scheduled)
    or (p_situation_filter in ('uploaded', 'processing', 'ready', 'failed') and state.status::text = p_situation_filter)
  )
  and (
    p_cursor_created_at is null
    or state.created_at < p_cursor_created_at
    or (state.created_at = p_cursor_created_at and state.id < p_cursor_id)
  )
  order by state.created_at desc, state.id desc
  limit greatest(1, least(p_limit, 101));
$$;

create or replace function public.count_gallery_media_ids(
  p_organization_id uuid,
  p_situation_filter text default 'all',
  p_type_filter text default 'all',
  p_group_id uuid default null,
  p_ungrouped boolean default false,
  p_search text default ''
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
      asset.status,
      (asset.first_published_at is not null) as is_published,
      exists (
        select 1
        from public.publication_item_media link
        join public.publication_items item
          on item.id = link.publication_item_id
         and item.organization_id = link.organization_id
        where link.organization_id = p_organization_id
          and link.media_asset_id = asset.id
          and item.status in ('waiting', 'ready', 'preparing', 'publishing')
      ) as is_scheduled
    from public.media_assets asset
    where asset.organization_id = p_organization_id
      and asset.deleted_at is null
      and public.is_organization_member(p_organization_id)
      and (p_type_filter = 'all' or asset.kind::text = p_type_filter)
      and (coalesce(nullif(trim(p_search), ''), '') = '' or asset.original_name ilike ('%' || replace(replace(replace(trim(p_search), '\\', '\\\\'), '%', '\%'), '_', '\_') || '%') escape '\')
      and (
        (p_group_id is null and not p_ungrouped)
        or (p_group_id is not null and exists (
          select 1
          from public.media_group_assignments assignment
          where assignment.organization_id = p_organization_id
            and assignment.media_asset_id = asset.id
            and assignment.group_id = p_group_id
        ))
        or (p_ungrouped and not exists (
          select 1
          from public.media_group_assignments assignment
          where assignment.organization_id = p_organization_id
            and assignment.media_asset_id = asset.id
        ))
      )
  )
  select count(*)::integer
  from media_state state
  where (
    p_situation_filter = 'all'
    or (p_situation_filter = 'schedulable' and state.status = 'ready' and not state.is_published and not state.is_scheduled)
    or (p_situation_filter = 'unposted' and not state.is_published and not state.is_scheduled)
    or (p_situation_filter = 'scheduled' and state.is_scheduled)
    or (p_situation_filter = 'posted' and state.is_published)
    or (p_situation_filter = 'posted_scheduled' and state.is_published and state.is_scheduled)
    or (p_situation_filter in ('uploaded', 'processing', 'ready', 'failed') and state.status::text = p_situation_filter)
  );
$$;

revoke all on function public.list_gallery_media_ids(uuid, text, text, uuid, boolean, text, timestamptz, uuid, integer) from public, anon;
revoke all on function public.count_gallery_media_ids(uuid, text, text, uuid, boolean, text) from public, anon;
grant execute on function public.list_gallery_media_ids(uuid, text, text, uuid, boolean, text, timestamptz, uuid, integer) to authenticated, service_role;
grant execute on function public.count_gallery_media_ids(uuid, text, text, uuid, boolean, text) to authenticated, service_role;
