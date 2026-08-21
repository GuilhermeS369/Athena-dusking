-- Reservas de slots de publicação a cada 10 minutos.
-- Registros legados fora da grade continuam íntegros e não entram no índice.

create index if not exists publication_items_active_slot_lookup_idx
  on public.publication_items (organization_id, profile_id, execute_at)
  where status in ('waiting', 'ready', 'preparing', 'publishing')
    and execute_at is not null
    and extract(second from execute_at at time zone 'America/Sao_Paulo') = 0
    and mod(extract(minute from execute_at at time zone 'America/Sao_Paulo')::integer, 10) = 0;

create index if not exists publication_items_active_profile_schedule_idx
  on public.publication_items (organization_id, profile_id, execute_at)
  where status in ('waiting', 'ready', 'preparing', 'publishing')
    and execute_at is not null;

-- Mantém criação de lote, itens e vínculos de mídia em uma única transação.
-- A API valida perfil, grupo, mídia e formato antes de chamar esta função.
create or replace function public.queue_publication_batch(
  p_organization_id uuid,
  p_name text,
  p_scheduled_for timestamptz,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  batch_row public.publication_batches%rowtype;
  item_json jsonb;
  item_row public.publication_items%rowtype;
  media_id uuid;
  resolved_execute_at timestamptz;
  candidate_day date;
  item_ids jsonb := '[]'::jsonb;
begin
  if not public.has_organization_role(p_organization_id, array['admin', 'operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception using errcode = '22023', message = 'Informe itens de publicação.';
  end if;

  insert into public.publication_batches (
    organization_id, created_by, name, scheduled_for, status, review_confirmed_at
  ) values (
    p_organization_id, auth.uid(), nullif(left(trim(coalesce(p_name, '')), 160), ''),
    p_scheduled_for, 'queued', timezone('utc', now())
  ) returning * into batch_row;

  for item_json in select value from jsonb_array_elements(p_items)
  loop
    -- Serializa reservas do mesmo perfil sem bloquear outros perfis ou organizações.
    perform pg_advisory_xact_lock(hashtextextended((item_json ->> 'profileId'), 0));
    resolved_execute_at := nullif(item_json ->> 'executeAt', '')::timestamptz;
    if resolved_execute_at is null and nullif(item_json ->> 'scheduleTime', '') is not null then
      candidate_day := timezone('America/Sao_Paulo', now())::date;
      loop
        resolved_execute_at := (candidate_day + (item_json ->> 'scheduleTime')::time) at time zone 'America/Sao_Paulo';
        exit when resolved_execute_at > timezone('utc', now()) and not exists (
          select 1 from public.publication_items occupied
          where occupied.organization_id = p_organization_id
            and occupied.profile_id = (item_json ->> 'profileId')::uuid
            and occupied.execute_at = resolved_execute_at
            and occupied.status in ('waiting', 'ready', 'preparing', 'publishing')
        );
        candidate_day := candidate_day + 1;
      end loop;
    end if;
    if nullif(item_json ->> 'executeAt', '') is not null and exists (
      select 1
      from public.publication_items occupied
      where occupied.organization_id = p_organization_id
        and occupied.profile_id = (item_json ->> 'profileId')::uuid
        and occupied.execute_at = (item_json ->> 'executeAt')::timestamptz
        and occupied.status in ('waiting', 'ready', 'preparing', 'publishing')
    ) then
      raise exception using errcode = 'P0001', message = 'slot_conflict';
    end if;

    insert into public.publication_items (
      organization_id, batch_id, profile_id, format, status, execute_at, caption, idempotency_key
    ) values (
      p_organization_id,
      batch_row.id,
      (item_json ->> 'profileId')::uuid,
      (item_json ->> 'format')::public.publication_format,
      case when resolved_execute_at is null then 'ready'::public.publication_item_status else 'waiting'::public.publication_item_status end,
      resolved_execute_at,
      nullif(item_json ->> 'caption', ''),
      item_json ->> 'idempotencyKey'
    ) returning * into item_row;

    for media_id in select value::uuid from jsonb_array_elements_text(item_json -> 'mediaIds')
    loop
      insert into public.publication_item_media (organization_id, publication_item_id, media_asset_id, position)
      values (p_organization_id, item_row.id, media_id,
        (select count(*) from public.publication_item_media where publication_item_id = item_row.id));
    end loop;
    item_ids := item_ids || to_jsonb(item_row.id);
  end loop;

  return jsonb_build_object(
    'batch', jsonb_build_object(
      'id', batch_row.id, 'name', batch_row.name, 'status', batch_row.status,
      'scheduled_for', batch_row.scheduled_for, 'timezone', batch_row.timezone,
      'review_confirmed_at', batch_row.review_confirmed_at, 'created_at', batch_row.created_at,
      'updated_at', batch_row.updated_at
    ),
    'itemIds', item_ids
  );
end;
$$;

revoke all on function public.queue_publication_batch(uuid, text, timestamptz, jsonb) from public, anon;
grant execute on function public.queue_publication_batch(uuid, text, timestamptz, jsonb) to authenticated;

-- A criação passa obrigatoriamente pela função transacional acima; assim não há
-- uma rota de inserção autenticada que possa contornar a reserva serializada.
revoke insert on table public.publication_batches from authenticated;
revoke insert on table public.publication_items from authenticated;
revoke insert on table public.publication_item_media from authenticated;
