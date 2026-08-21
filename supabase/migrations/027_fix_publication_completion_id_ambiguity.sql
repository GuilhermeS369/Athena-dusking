-- Corrige a ambiguidade entre a coluna de retorno `id` e `publication_items.id`.
-- Esta migration apenas redefine a função; não reivindica, republica nem altera
-- itens históricos já existentes na fila.

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
language plpgsql
security definer
set search_path = public
as $$
declare
  item_row public.publication_items%rowtype;
  updated_row public.publication_items%rowtype;
  retry_delay_seconds integer;
begin
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido';
  end if;
  if p_outcome not in ('published', 'failed') then
    raise exception using errcode = '22023', message = 'Resultado de publicação inválido';
  end if;
  if p_max_attempts not between 1 and 20 then
    raise exception using errcode = '22023', message = 'Máximo de tentativas deve estar entre 1 e 20';
  end if;

  select item_source.* into item_row
  from public.publication_items as item_source
  where item_source.id = p_item_id
    and item_source.claimed_by = trim(p_worker_id)
    and item_source.lease_until > timezone('utc', now())
    and item_source.status in ('preparing', 'publishing')
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Item não está sob lease deste worker';
  end if;

  if p_outcome = 'published' then
    update public.publication_items as item_update
    set
      status = 'published',
      meta_media_id = coalesce(nullif(trim(p_meta_media_id), ''), item_update.meta_media_id),
      published_at = timezone('utc', now()),
      claimed_by = null,
      lease_until = null,
      next_attempt_at = null,
      last_error_code = null,
      last_error_message = null
    where item_update.id = item_row.id
    returning item_update.* into updated_row;

    -- Restaura o registro de primeira publicação que foi perdido quando a
    -- função foi redefinida pela migration de eventos.
    update public.media_assets as asset
    set first_published_at = coalesce(asset.first_published_at, timezone('utc', now()))
    from public.publication_item_media as item_media
    where item_media.publication_item_id = item_row.id
      and item_media.media_asset_id = asset.id
      and asset.organization_id = item_row.organization_id;
  elsif p_retryable and item_row.attempt_count < p_max_attempts then
    retry_delay_seconds := (60 * power(2, least(item_row.attempt_count - 1, 6)))::integer
      + floor(random() * 31)::integer;

    update public.publication_items as item_update
    set
      status = 'failed',
      claimed_by = null,
      lease_until = null,
      next_attempt_at = timezone('utc', now()) + make_interval(secs => retry_delay_seconds),
      last_error_code = left(nullif(trim(p_error_code), ''), 120),
      last_error_message = left(nullif(trim(p_error_message), ''), 1200)
    where item_update.id = item_row.id
    returning item_update.* into updated_row;
  else
    update public.publication_items as item_update
    set
      status = 'failed',
      claimed_by = null,
      lease_until = null,
      next_attempt_at = null,
      last_error_code = left(nullif(trim(p_error_code), ''), 120),
      last_error_message = left(nullif(trim(p_error_message), ''), 1200)
    where item_update.id = item_row.id
    returning item_update.* into updated_row;
  end if;

  perform public.log_publication_item_event(
    updated_row.id,
    case
      when updated_row.status = 'published' then 'published'::public.publication_item_event_type
      else 'failed'::public.publication_item_event_type
    end,
    item_row.status,
    updated_row.status,
    null,
    trim(p_worker_id),
    case when updated_row.status = 'failed' then updated_row.last_error_code else null end,
    case when updated_row.status = 'failed' then updated_row.last_error_message else null end,
    jsonb_build_object(
      'attempt_count', updated_row.attempt_count,
      'next_attempt_at', updated_row.next_attempt_at
    )
  );

  update public.publication_batches as batch_row
  set status = case
    when exists (
      select 1
      from public.publication_items as item_check
      where item_check.batch_id = item_row.batch_id
        and item_check.status not in ('published', 'failed', 'ignored', 'cancelled', 'removed')
    ) then 'processing'
    when exists (
      select 1
      from public.publication_items as item_check
      where item_check.batch_id = item_row.batch_id
        and item_check.status = 'failed'
    ) then 'completed_with_errors'
    when not exists (
      select 1
      from public.publication_items as item_check
      where item_check.batch_id = item_row.batch_id
        and item_check.status <> 'cancelled'
    ) then 'cancelled'
    else 'completed'
  end
  where batch_row.id = item_row.batch_id;

  return query
  select
    item_result.id,
    item_result.status,
    item_result.attempt_count,
    item_result.next_attempt_at,
    item_result.published_at
  from public.publication_items as item_result
  where item_result.id = item_row.id;
end;
$$;

revoke all on function public.complete_publication_item(uuid, text, text, text, text, text, boolean, integer)
  from public, anon, authenticated;
grant execute on function public.complete_publication_item(uuid, text, text, text, text, text, boolean, integer)
  to service_role;
