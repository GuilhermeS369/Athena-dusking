-- Ancora a consulta da recuperação no instante em que a criação substituta
-- foi realmente aceita, inclusive quando o lote permaneceu pausado entre o
-- agendamento da recuperação e a chamada externa à Zernio.

create or replace function public.defer_publication_item(
  p_item_id uuid,
  p_worker_id text,
  p_creation_id text,
  p_delay_seconds integer default 60,
  p_is_poll boolean default false
)
returns table (
  id uuid,
  status public.publication_item_status,
  creation_id text,
  next_attempt_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  item_row public.publication_items%rowtype;
  updated_row public.publication_items%rowtype;
  now_at timestamptz := timezone('utc', now());
  effective_delay_seconds integer;
  replacement_creation boolean;
begin
  if p_delay_seconds not between 15 and 900 then
    raise exception using errcode = '22023', message = 'Aguardar entre 15 e 900 segundos';
  end if;

  select item.* into item_row
  from public.publication_items item
  where item.id = p_item_id
    and item.claimed_by = trim(p_worker_id)
    and item.lease_until > now_at
    and item.status in ('preparing', 'publishing')
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Item não está sob lease deste worker';
  end if;
  if p_is_poll and item_row.creation_id is distinct from trim(p_creation_id) then
    raise exception using errcode = '22023', message = 'Polling requer a criação persistida do item';
  end if;

  replacement_creation := not p_is_poll
    and item_row.zernio_recovery_count = 1
    and item_row.creation_id is null;
  effective_delay_seconds := case
    when replacement_creation then 180
    else p_delay_seconds
  end;

  update public.publication_items item
  set status = 'waiting',
      creation_id = trim(p_creation_id),
      claimed_by = null,
      lease_until = null,
      next_attempt_at = now_at + make_interval(secs => effective_delay_seconds),
      provider_creation_started_at = case
        when p_is_poll then item.provider_creation_started_at
        else now_at
      end,
      container_poll_count = case
        when p_is_poll then item.container_poll_count + 1
        else 0
      end,
      zernio_recovery_poll_at = case
        when replacement_creation then now_at + interval '3 minutes'
        else item.zernio_recovery_poll_at
      end,
      last_error_code = null,
      last_error_message = null
  where item.id = item_row.id
  returning item.* into updated_row;

  if replacement_creation then
    update public.publication_zernio_recoveries recovery
    set replacement_creation_id = updated_row.creation_id,
        replacement_created_at = now_at,
        replacement_poll_at = updated_row.zernio_recovery_poll_at
    where recovery.publication_item_id = updated_row.id
      and recovery.replacement_creation_id is null;
  end if;

  perform public.log_publication_item_event(
    updated_row.id,
    'processing_deferred',
    item_row.status,
    updated_row.status,
    null,
    trim(p_worker_id),
    null,
    null,
    jsonb_build_object(
      'creation_id', updated_row.creation_id,
      'container_poll_count', updated_row.container_poll_count,
      'next_attempt_at', updated_row.next_attempt_at,
      'replacement_creation', replacement_creation
    )
  );

  return query
  select updated_row.id, updated_row.status, updated_row.creation_id, updated_row.next_attempt_at;
end;
$$;

revoke all on function public.defer_publication_item(uuid, text, text, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.defer_publication_item(uuid, text, text, integer, boolean)
  to service_role;

notify pgrst, 'reload schema';
