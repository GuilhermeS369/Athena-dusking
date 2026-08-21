-- Ao apagar uma mídia pela galeria, encerra somente os itens de fila que
-- dependem dela. O restante do lote continua executável normalmente.

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
  if not public.has_organization_role(p_organization_id, array['admin', 'operator']::public.organization_role[]) then
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
        auth.jwt() ->> 'email',
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

revoke all on function public.delete_media_assets_and_remove_publication_items(uuid, uuid[]) from public, anon;
grant execute on function public.delete_media_assets_and_remove_publication_items(uuid, uuid[]) to authenticated, service_role;

create or replace function public.complete_publication_item(
  p_item_id uuid,
  p_worker_id text,
  p_outcome text,
  p_meta_media_id text default null,
  p_error_code text default null,
  p_error_message text default null,
  p_retryable boolean default false,
  p_max_attempts integer default 5
)
returns table (
  id uuid,
  status public.publication_item_status,
  attempt_count integer,
  next_attempt_at timestamptz,
  published_at timestamptz
)
language plpgsql security definer set search_path = public
as $$
declare
  item_row public.publication_items%rowtype;
  updated_row public.publication_items%rowtype;
  retry_delay_seconds integer;
begin
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido';
  end if;
  if p_outcome not in ('published', 'failed', 'removed') then
    raise exception using errcode = '22023', message = 'Resultado de publicação inválido';
  end if;
  if p_max_attempts not between 1 and 20 then
    raise exception using errcode = '22023', message = 'Máximo de tentativas deve estar entre 1 e 20';
  end if;

  select * into item_row from public.publication_items
  where id = p_item_id and claimed_by = trim(p_worker_id)
    and lease_until > timezone('utc', now()) and status in ('preparing', 'publishing')
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Item não está sob lease deste worker';
  end if;

  if p_outcome = 'published' then
    update public.publication_items set
      status = 'published', meta_media_id = coalesce(nullif(trim(p_meta_media_id), ''), meta_media_id),
      published_at = timezone('utc', now()), claimed_by = null, lease_until = null,
      next_attempt_at = null, last_error_code = null, last_error_message = null
    where id = item_row.id returning * into updated_row;
  elsif p_outcome = 'removed' then
    update public.publication_items set
      status = 'removed', cancelled_at = timezone('utc', now()), claimed_by = null,
      lease_until = null, next_attempt_at = null, creation_id = null,
      last_error_code = left(coalesce(nullif(trim(p_error_code), ''), 'media_deleted'), 120),
      last_error_message = left(coalesce(nullif(trim(p_error_message), ''), 'Mídia apagada.'), 1200)
    where id = item_row.id returning * into updated_row;
  elsif p_retryable and item_row.attempt_count < p_max_attempts then
    retry_delay_seconds := (60 * power(2, least(item_row.attempt_count - 1, 6)))::integer + floor(random() * 31)::integer;
    update public.publication_items set
      status = 'failed', claimed_by = null, lease_until = null,
      next_attempt_at = timezone('utc', now()) + make_interval(secs => retry_delay_seconds),
      last_error_code = left(nullif(trim(p_error_code), ''), 120),
      last_error_message = left(nullif(trim(p_error_message), ''), 1200)
    where id = item_row.id returning * into updated_row;
  else
    update public.publication_items set
      status = 'failed', claimed_by = null, lease_until = null, next_attempt_at = null,
      last_error_code = left(nullif(trim(p_error_code), ''), 120),
      last_error_message = left(nullif(trim(p_error_message), ''), 1200)
    where id = item_row.id returning * into updated_row;
  end if;

  perform public.log_publication_item_event(
    updated_row.id,
    case
      when updated_row.status = 'published' then 'published'::public.publication_item_event_type
      when updated_row.status = 'removed' then 'cancelled'::public.publication_item_event_type
      else 'failed'::public.publication_item_event_type
    end,
    item_row.status, updated_row.status, null, trim(p_worker_id),
    case when updated_row.status in ('failed', 'removed') then updated_row.last_error_code else null end,
    case when updated_row.status in ('failed', 'removed') then updated_row.last_error_message else null end,
    jsonb_build_object('attempt_count', updated_row.attempt_count, 'next_attempt_at', updated_row.next_attempt_at)
  );

  perform public.sync_publication_batch_status(item_row.batch_id);

  return query select updated_row.id, updated_row.status, updated_row.attempt_count, updated_row.next_attempt_at, updated_row.published_at;
end;
$$;

revoke all on function public.complete_publication_item(uuid, text, text, text, text, text, boolean, integer) from public, anon, authenticated;
grant execute on function public.complete_publication_item(uuid, text, text, text, text, text, boolean, integer) to service_role;
