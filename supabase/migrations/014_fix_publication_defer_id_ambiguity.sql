-- Corrige a função que salva o creation_id do contêiner.
-- O retorno da função possui uma coluna chamada id; por isso `where id = ...`
-- é ambíguo dentro do PL/pgSQL e pode impedir qualquer Reel de avançar.

create or replace function public.defer_publication_item(
  p_item_id uuid,
  p_worker_id text,
  p_creation_id text,
  p_delay_seconds integer default 60
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
begin
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido';
  end if;

  if char_length(trim(coalesce(p_creation_id, ''))) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'Identificador de contêiner inválido';
  end if;

  if p_delay_seconds not between 15 and 900 then
    raise exception using errcode = '22023', message = 'Aguardar entre 15 e 900 segundos';
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

  return query
  update public.publication_items as item_update
  set status = 'waiting',
      creation_id = trim(p_creation_id),
      claimed_by = null,
      lease_until = null,
      next_attempt_at = timezone('utc', now()) + make_interval(secs => p_delay_seconds),
      last_error_code = null,
      last_error_message = null
  where item_update.id = item_row.id
  returning item_update.id, item_update.status, item_update.creation_id,
    item_update.next_attempt_at;
end;
$$;

revoke all on function public.defer_publication_item(uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.defer_publication_item(uuid, text, text, integer) to service_role;
