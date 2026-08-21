-- Corrige a ambiguidade reintroduzida na função de conclusão de publicação.
-- A função retorna uma coluna chamada `id`; por isso qualquer referência não
-- qualificada a `id` dentro do PL/pgSQL pode ser interpretada como variável de
-- retorno ou coluna da tabela. Esta versão qualifica todas as colunas e preserva
-- os pós-processamentos de sucesso, remoção e limite diário.

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
  if p_outcome not in ('published', 'failed', 'removed') then
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

    update public.media_assets as asset
    set first_published_at = coalesce(asset.first_published_at, timezone('utc', now()))
    from public.publication_item_media as item_media
    where item_media.publication_item_id = item_row.id
      and item_media.media_asset_id = asset.id
      and asset.organization_id = item_row.organization_id;
  elsif p_outcome = 'removed' then
    update public.publication_items as item_update
    set
      status = 'removed',
      cancelled_at = timezone('utc', now()),
      claimed_by = null,
      lease_until = null,
      next_attempt_at = null,
      creation_id = null,
      last_error_code = left(coalesce(nullif(trim(p_error_code), ''), 'media_deleted'), 120),
      last_error_message = left(coalesce(nullif(trim(p_error_message), ''), 'Mídia apagada.'), 1200)
    where item_update.id = item_row.id
    returning item_update.* into updated_row;
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

  delete from public.publication_profile_daily_reservations as reservation
  where reservation.publication_item_id = item_row.id;

  perform public.log_publication_item_event(
    updated_row.id,
    case
      when updated_row.status = 'published' then 'published'::public.publication_item_event_type
      when updated_row.status = 'removed' then 'cancelled'::public.publication_item_event_type
      else 'failed'::public.publication_item_event_type
    end,
    item_row.status,
    updated_row.status,
    null,
    trim(p_worker_id),
    case when updated_row.status in ('failed', 'removed') then updated_row.last_error_code else null end,
    case when updated_row.status in ('failed', 'removed') then updated_row.last_error_message else null end,
    jsonb_build_object(
      'attempt_count', updated_row.attempt_count,
      'next_attempt_at', updated_row.next_attempt_at
    )
  );

  perform public.sync_publication_batch_status(item_row.batch_id);

  return query
  select
    result_item.id,
    result_item.status,
    result_item.attempt_count,
    result_item.next_attempt_at,
    result_item.published_at
  from public.publication_items as result_item
  where result_item.id = updated_row.id;
end;
$$;

revoke all on function public.complete_publication_item(uuid, text, text, text, text, text, boolean, integer)
  from public, anon, authenticated;
grant execute on function public.complete_publication_item(uuid, text, text, text, text, text, boolean, integer)
  to service_role;
