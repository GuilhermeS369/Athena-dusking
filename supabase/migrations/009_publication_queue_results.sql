-- Athena Scheduler: conclusão de itens, falhas normalizadas e retentativas seguras.

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

  select * into item_row
  from public.publication_items
  where id = p_item_id
    and claimed_by = trim(p_worker_id)
    and lease_until > timezone('utc', now())
    and status in ('preparing', 'publishing')
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Item não está sob lease deste worker';
  end if;

  if p_outcome = 'published' then
    return query
    update public.publication_items
    set
      status = 'published',
      meta_media_id = coalesce(nullif(trim(p_meta_media_id), ''), meta_media_id),
      published_at = timezone('utc', now()),
      claimed_by = null,
      lease_until = null,
      next_attempt_at = null,
      last_error_code = null,
      last_error_message = null
    where id = item_row.id
    returning publication_items.id, publication_items.status, publication_items.attempt_count,
      publication_items.next_attempt_at, publication_items.published_at;
  elsif p_retryable and item_row.attempt_count < p_max_attempts then
    retry_delay_seconds := (60 * power(2, least(item_row.attempt_count - 1, 6)))::integer
      + floor(random() * 31)::integer;

    return query
    update public.publication_items
    set
      status = 'failed',
      claimed_by = null,
      lease_until = null,
      next_attempt_at = timezone('utc', now()) + make_interval(secs => retry_delay_seconds),
      last_error_code = left(nullif(trim(p_error_code), ''), 120),
      last_error_message = left(nullif(trim(p_error_message), ''), 1200)
    where id = item_row.id
    returning publication_items.id, publication_items.status, publication_items.attempt_count,
      publication_items.next_attempt_at, publication_items.published_at;
  else
    return query
    update public.publication_items
    set
      status = 'failed',
      claimed_by = null,
      lease_until = null,
      next_attempt_at = null,
      last_error_code = left(nullif(trim(p_error_code), ''), 120),
      last_error_message = left(nullif(trim(p_error_message), ''), 1200)
    where id = item_row.id
    returning publication_items.id, publication_items.status, publication_items.attempt_count,
      publication_items.next_attempt_at, publication_items.published_at;
  end if;

  update public.publication_batches batch_row
  set status = case
    when exists (
      select 1 from public.publication_items item
      where item.batch_id = item_row.batch_id
        and item.status not in ('published', 'failed', 'ignored', 'cancelled', 'removed')
    ) then 'processing'
    when exists (
      select 1 from public.publication_items item
      where item.batch_id = item_row.batch_id and item.status = 'failed'
    ) then 'completed_with_errors'
    else 'completed'
  end
  where batch_row.id = item_row.batch_id;
end;
$$;

revoke all on function public.complete_publication_item(uuid, text, text, text, text, text, boolean, integer) from public, anon, authenticated;
grant execute on function public.complete_publication_item(uuid, text, text, text, text, text, boolean, integer) to service_role;
