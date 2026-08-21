-- Cada formato possui uma agenda própria dentro de um perfil. Assim, Reel,
-- Story, Imagem e Carrossel podem compartilhar data/hora, mas um formato não
-- pode reservar duas vezes o mesmo slot ativo.
create index if not exists publication_items_active_format_slot_lookup_idx
  on public.publication_items (organization_id, profile_id, format, execute_at)
  where status in ('waiting', 'ready', 'preparing', 'publishing')
    and execute_at is not null;

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
  item_format public.publication_format;
  item_ids jsonb := '[]'::jsonb;
begin
  if not public.has_organization_role(p_organization_id, array['admin', 'operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception using errcode = '22023', message = 'Informe itens de publicação.';
  end if;

  insert into public.publication_batches (
    organization_id, created_by, created_by_email, name, scheduled_for, status, review_confirmed_at
  ) values (
    p_organization_id, auth.uid(), nullif(auth.jwt() ->> 'email', ''),
    nullif(left(trim(coalesce(p_name, '')), 160), ''), p_scheduled_for, 'queued', timezone('utc', now())
  ) returning * into batch_row;

  for item_json in select value from jsonb_array_elements(p_items)
  loop
    item_format := (item_json ->> 'format')::public.publication_format;
    -- Serializa somente reservas que disputam a mesma agenda de formato.
    perform pg_advisory_xact_lock(hashtextextended((item_json ->> 'profileId') || ':' || item_format::text, 0));
    resolved_execute_at := nullif(item_json ->> 'executeAt', '')::timestamptz;

    if resolved_execute_at is null and nullif(item_json ->> 'scheduleTime', '') is not null then
      candidate_day := timezone('America/Sao_Paulo', now())::date;
      loop
        resolved_execute_at := (candidate_day + (item_json ->> 'scheduleTime')::time) at time zone 'America/Sao_Paulo';
        exit when resolved_execute_at > timezone('utc', now()) and not exists (
          select 1 from public.publication_items occupied
          where occupied.organization_id = p_organization_id
            and occupied.profile_id = (item_json ->> 'profileId')::uuid
            and occupied.format = item_format
            and occupied.execute_at = resolved_execute_at
            and occupied.status in ('waiting', 'ready', 'preparing', 'publishing')
        );
        candidate_day := candidate_day + 1;
      end loop;
    end if;

    if nullif(item_json ->> 'executeAt', '') is not null and exists (
      select 1 from public.publication_items occupied
      where occupied.organization_id = p_organization_id
        and occupied.profile_id = (item_json ->> 'profileId')::uuid
        and occupied.format = item_format
        and occupied.execute_at = (item_json ->> 'executeAt')::timestamptz
        and occupied.status in ('waiting', 'ready', 'preparing', 'publishing')
    ) then
      raise exception using errcode = 'P0001', message = 'slot_conflict';
    end if;

    insert into public.publication_items (
      organization_id, batch_id, profile_id, format, status, execute_at, caption, idempotency_key
    ) values (
      p_organization_id, batch_row.id, (item_json ->> 'profileId')::uuid, item_format,
      case when resolved_execute_at is null then 'ready'::public.publication_item_status else 'waiting'::public.publication_item_status end,
      resolved_execute_at, nullif(item_json ->> 'caption', ''), item_json ->> 'idempotencyKey'
    ) returning * into item_row;

    for media_id in select value::uuid from jsonb_array_elements_text(item_json -> 'mediaIds')
    loop
      insert into public.publication_item_media (organization_id, publication_item_id, media_asset_id, position)
      values (p_organization_id, item_row.id, media_id, (select count(*) from public.publication_item_media where publication_item_id = item_row.id));
    end loop;

    perform public.log_publication_item_event(item_row.id, 'queued', null, item_row.status, auth.uid(), auth.jwt() ->> 'email', null, null, jsonb_build_object('execute_at', item_row.execute_at));
    item_ids := item_ids || to_jsonb(item_row.id);
  end loop;

  return jsonb_build_object('batch', jsonb_build_object(
    'id', batch_row.id, 'name', batch_row.name, 'status', batch_row.status,
    'scheduled_for', batch_row.scheduled_for, 'timezone', batch_row.timezone,
    'review_confirmed_at', batch_row.review_confirmed_at, 'created_at', batch_row.created_at,
    'updated_at', batch_row.updated_at, 'created_by_email', batch_row.created_by_email
  ), 'itemIds', item_ids);
end;
$$;

create or replace function public.enforce_active_publication_slot_uniqueness()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.execute_at is not null
    and new.status in ('waiting', 'ready', 'preparing', 'publishing')
    and exists (
      select 1
      from public.publication_items occupied
      where occupied.organization_id = new.organization_id
        and occupied.profile_id = new.profile_id
        and occupied.format = new.format
        and occupied.execute_at = new.execute_at
        and occupied.status in ('waiting', 'ready', 'preparing', 'publishing')
        and occupied.id <> new.id
    ) then
    raise exception using errcode = '23505', message = 'active_publication_slot_conflict';
  end if;
  return new;
end;
$$;

revoke all on function public.queue_publication_batch(uuid, text, timestamptz, jsonb) from public, anon;
grant execute on function public.queue_publication_batch(uuid, text, timestamptz, jsonb) to authenticated;
revoke all on function public.enforce_active_publication_slot_uniqueness() from public;
