-- Protege mídias referenciadas por jobs grandes de geração ainda ativos.
-- A exclusão em massa da galeria não deve apagar arquivos que ainda existem em
-- payloads de jobs/chunks pendentes, porque o worker pode materializar esses
-- itens depois da seleção visual da galeria.

create or replace function public.media_asset_is_in_active_generation_job(
  p_organization_id uuid,
  p_media_asset_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.publication_generation_jobs as job
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(job.payload -> 'items') = 'array' then job.payload -> 'items' else '[]'::jsonb end
    ) as payload_item(item)
    where job.organization_id = p_organization_id
      and job.status in ('queued', 'processing', 'paused')
      and jsonb_typeof(job.payload -> 'items') = 'array'
      and jsonb_typeof(payload_item.item -> 'mediaIds') = 'array'
      and exists (
        select 1
        from jsonb_array_elements_text(payload_item.item -> 'mediaIds') as media_value(id)
        where media_value.id = p_media_asset_id::text
      )
  ) or exists (
    select 1
    from public.publication_generation_job_chunks as chunk
    join public.publication_generation_jobs as job on job.id = chunk.job_id
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(chunk.payload) = 'array' then chunk.payload else '[]'::jsonb end
    ) as payload_item(item)
    where chunk.organization_id = p_organization_id
      and job.organization_id = p_organization_id
      and job.status in ('queued', 'processing', 'paused')
      and chunk.status in ('queued', 'processing', 'failed')
      and jsonb_typeof(chunk.payload) = 'array'
      and jsonb_typeof(payload_item.item -> 'mediaIds') = 'array'
      and exists (
        select 1
        from jsonb_array_elements_text(payload_item.item -> 'mediaIds') as media_value(id)
        where media_value.id = p_media_asset_id::text
      )
  );
$$;

create or replace function public.delete_media_assets_and_remove_publication_items(
  p_organization_id uuid,
  p_media_asset_ids uuid[]
)
returns table (
  media_asset_id uuid,
  storage_path text,
  thumbnail_storage_path text,
  affected_item_ids uuid[],
  affected_batch_ids uuid[]
)
language plpgsql
security definer
set search_path = public
as $$
declare
  asset_ids uuid[] := array(select distinct unnest(coalesce(p_media_asset_ids, '{}'::uuid[])));
  asset_row public.media_assets%rowtype;
  item_row public.publication_items%rowtype;
  updated_item public.publication_items%rowtype;
  item_ids uuid[];
  batch_ids uuid[];
  batch_id uuid;
  deleted_at_value timestamptz := timezone('utc', now());
begin
  if coalesce(auth.role(), '') <> 'service_role' and not public.has_organization_role(p_organization_id, array['admin', 'operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  if coalesce(array_length(asset_ids, 1), 0) = 0 or array_length(asset_ids, 1) > 100 then
    raise exception using errcode = '22023', message = 'Selecione entre 1 e 100 mídias para excluir.';
  end if;

  for asset_row in
    select *
    from public.media_assets
    where organization_id = p_organization_id
      and deleted_at is null
      and id = any(asset_ids)
      and not public.media_asset_is_in_active_generation_job(p_organization_id, id)
    for update
  loop
    item_ids := '{}'::uuid[];
    batch_ids := '{}'::uuid[];

    for item_row in
      select item.*
      from public.publication_items item
      where item.organization_id = p_organization_id
        and item.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed')
        and exists (
          select 1
          from public.publication_item_media link
          where link.publication_item_id = item.id
            and link.organization_id = item.organization_id
            and link.media_asset_id = asset_row.id
        )
      for update of item
    loop
      update public.publication_items
      set status = 'removed',
          cancelled_at = deleted_at_value,
          next_attempt_at = null,
          lease_until = null,
          claimed_by = null,
          creation_id = null,
          last_error_code = 'media_deleted',
          last_error_message = 'Mídia apagada.'
      where id = item_row.id
      returning * into updated_item;

      perform public.log_publication_item_event(
        updated_item.id,
        'cancelled',
        item_row.status,
        updated_item.status,
        auth.uid(),
        coalesce(auth.jwt() ->> 'email', 'worker:media-deletion'),
        'media_deleted',
        'Mídia apagada.',
        jsonb_build_object(
          'action', 'media_deleted_from_gallery',
          'media_asset_id', asset_row.id,
          'media_original_name', asset_row.original_name
        )
      );

      item_ids := array_append(item_ids, updated_item.id);
      if not updated_item.batch_id = any(batch_ids) then
        batch_ids := array_append(batch_ids, updated_item.batch_id);
      end if;
    end loop;

    delete from public.media_group_assignments assignment
    where assignment.organization_id = p_organization_id
      and assignment.media_asset_id = asset_row.id;

    update public.media_assets
    set deleted_at = deleted_at_value,
        deletion_requested_at = null,
        deletion_requested_by = null,
        status = 'deleted',
        processing_error = null
    where id = asset_row.id
      and organization_id = p_organization_id;

    foreach batch_id in array batch_ids
    loop
      perform public.sync_publication_batch_status(batch_id);
    end loop;

    media_asset_id := asset_row.id;
    storage_path := asset_row.storage_path;
    thumbnail_storage_path := asset_row.thumbnail_storage_path;
    affected_item_ids := item_ids;
    affected_batch_ids := batch_ids;
    return next;
  end loop;
end;
$$;

create or replace function public.create_media_deletion_job(
  p_organization_id uuid,
  p_media_asset_ids uuid[]
)
returns table (
  job_id uuid,
  total_count integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  asset_ids uuid[] := array(select distinct unnest(coalesce(p_media_asset_ids, '{}'::uuid[])));
  new_job public.media_deletion_jobs%rowtype;
  request_time timestamptz := timezone('utc', now());
begin
  if coalesce(auth.role(), '') <> 'service_role' and not public.has_organization_role(p_organization_id, array['admin', 'operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  if coalesce(array_length(asset_ids, 1), 0) = 0 then
    raise exception using errcode = '22023', message = 'Selecione ao menos uma mídia para excluir.';
  end if;

  insert into public.media_deletion_jobs (organization_id, requested_by, requested_by_email, status)
  values (p_organization_id, auth.uid(), nullif(auth.jwt() ->> 'email', ''), 'pending')
  returning * into new_job;

  insert into public.media_deletion_job_items (job_id, organization_id, media_asset_id)
  select new_job.id, p_organization_id, asset.id
  from public.media_assets asset
  where asset.organization_id = p_organization_id
    and asset.deleted_at is null
    and asset.deletion_requested_at is null
    and asset.id = any(asset_ids)
    and not public.media_asset_is_in_active_generation_job(p_organization_id, asset.id);

  update public.media_assets asset
  set deletion_requested_at = request_time,
      deletion_requested_by = auth.uid()
  where asset.organization_id = p_organization_id
    and asset.deleted_at is null
    and asset.deletion_requested_at is null
    and asset.id in (
      select item.media_asset_id
      from public.media_deletion_job_items item
      where item.job_id = new_job.id
    );

  update public.media_deletion_jobs job
  set total_count = (
    select count(*)::integer
    from public.media_deletion_job_items item
    where item.job_id = new_job.id
  ),
  status = case when exists (select 1 from public.media_deletion_job_items item where item.job_id = new_job.id) then 'pending' else 'completed' end,
  finished_at = case when exists (select 1 from public.media_deletion_job_items item where item.job_id = new_job.id) then null else request_time end
  where job.id = new_job.id
  returning job.* into new_job;

  job_id := new_job.id;
  total_count := new_job.total_count;
  return next;
end;
$$;

create or replace function public.list_gallery_media_ids_for_deletion(
  p_organization_id uuid,
  p_situation_filter text default 'all',
  p_type_filter text default 'all',
  p_group_id uuid default null,
  p_ungrouped boolean default false,
  p_search text default '',
  p_limit integer default 50000
)
returns table (media_asset_id uuid)
language sql stable security definer set search_path = public
as $$
  with media_state as (
    select asset.id, asset.status, (asset.first_published_at is not null) as is_published,
      exists (
        select 1 from public.publication_item_media link
        join public.publication_items item on item.id = link.publication_item_id and item.organization_id = link.organization_id
        where link.organization_id = p_organization_id and link.media_asset_id = asset.id
          and public.media_item_is_active_schedule(item.status, item.execute_at, item.published_at)
      ) as is_scheduled
    from public.media_assets asset
    where asset.organization_id = p_organization_id
      and asset.deleted_at is null
      and asset.deletion_requested_at is null
      and public.media_asset_has_storage_object(asset.storage_path)
      and public.is_organization_member(p_organization_id)
      and not public.media_asset_is_in_active_generation_job(p_organization_id, asset.id)
      and (p_type_filter = 'all' or asset.kind::text = p_type_filter)
      and (coalesce(nullif(trim(p_search), ''), '') = '' or asset.original_name ilike ('%' || replace(replace(replace(trim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%') escape '\')
      and ((p_group_id is null and not p_ungrouped) or (p_group_id is not null and exists (select 1 from public.media_group_assignments assignment where assignment.organization_id = p_organization_id and assignment.media_asset_id = asset.id and assignment.group_id = p_group_id)) or (p_ungrouped and not exists (select 1 from public.media_group_assignments assignment where assignment.organization_id = p_organization_id and assignment.media_asset_id = asset.id)))
  )
  select state.id
  from media_state state
  where (p_situation_filter = 'all'
    or (p_situation_filter = 'schedulable' and state.status = 'ready' and not state.is_published and not state.is_scheduled)
    or (p_situation_filter = 'unposted' and not state.is_published and not state.is_scheduled)
    or (p_situation_filter = 'scheduled' and state.is_scheduled)
    or (p_situation_filter = 'posted' and state.is_published)
    or (p_situation_filter = 'posted_scheduled' and state.is_published and state.is_scheduled)
    or (p_situation_filter in ('uploaded', 'processing', 'ready', 'failed') and state.status::text = p_situation_filter))
  order by state.id
  limit least(greatest(p_limit, 1), 50000);
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
language sql stable security definer set search_path = public
as $$
  with media_state as (
    select asset.id, asset.status, (asset.first_published_at is not null) as is_published,
      exists (
        select 1 from public.publication_item_media link
        join public.publication_items item on item.id = link.publication_item_id and item.organization_id = link.organization_id
        where link.organization_id = p_organization_id and link.media_asset_id = asset.id
          and public.media_item_is_active_schedule(item.status, item.execute_at, item.published_at)
      ) as is_scheduled
    from public.media_assets asset
    where asset.organization_id = p_organization_id
      and asset.deleted_at is null
      and asset.deletion_requested_at is null
      and public.media_asset_has_storage_object(asset.storage_path)
      and public.is_organization_member(p_organization_id)
      and not public.media_asset_is_in_active_generation_job(p_organization_id, asset.id)
      and (p_type_filter = 'all' or asset.kind::text = p_type_filter)
      and (coalesce(nullif(trim(p_search), ''), '') = '' or asset.original_name ilike ('%' || replace(replace(replace(trim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%') escape '\')
      and ((p_group_id is null and not p_ungrouped) or (p_group_id is not null and exists (select 1 from public.media_group_assignments assignment where assignment.organization_id = p_organization_id and assignment.media_asset_id = asset.id and assignment.group_id = p_group_id)) or (p_ungrouped and not exists (select 1 from public.media_group_assignments assignment where assignment.organization_id = p_organization_id and assignment.media_asset_id = asset.id)))
  )
  select count(*)::integer
  from media_state state
  where (p_situation_filter = 'all'
    or (p_situation_filter = 'schedulable' and state.status = 'ready' and not state.is_published and not state.is_scheduled)
    or (p_situation_filter = 'unposted' and not state.is_published and not state.is_scheduled)
    or (p_situation_filter = 'scheduled' and state.is_scheduled)
    or (p_situation_filter = 'posted' and state.is_published)
    or (p_situation_filter = 'posted_scheduled' and state.is_published and state.is_scheduled)
    or (p_situation_filter in ('uploaded', 'processing', 'ready', 'failed') and state.status::text = p_situation_filter));
$$;

revoke all on function public.media_asset_is_in_active_generation_job(uuid, uuid) from public, anon;
revoke all on function public.count_gallery_media_ids(uuid, text, text, uuid, boolean, text) from public, anon;
grant execute on function public.media_asset_is_in_active_generation_job(uuid, uuid) to service_role;
grant execute on function public.delete_media_assets_and_remove_publication_items(uuid, uuid[]) to authenticated, service_role;
grant execute on function public.create_media_deletion_job(uuid, uuid[]) to authenticated;
grant execute on function public.count_gallery_media_ids(uuid, text, text, uuid, boolean, text) to authenticated, service_role;
grant execute on function public.list_gallery_media_ids_for_deletion(uuid, text, text, uuid, boolean, text, integer) to authenticated, service_role;
