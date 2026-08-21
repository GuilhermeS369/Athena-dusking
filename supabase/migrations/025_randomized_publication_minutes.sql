-- A reserva é por minuto e por perfil, sem separar formatos. Isto impede que
-- Reel, Story, Imagem e Carrossel do mesmo perfil sejam despachados no mesmo
-- minuto, mesmo quando os segundos forem diferentes.
create index if not exists publication_items_active_profile_execute_at_lookup_idx
  on public.publication_items (organization_id, profile_id, execute_at)
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
  candidate_window_start timestamptz;
  candidate_minute timestamptz;
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
    -- A mesma trava é usada por todos os formatos: o minuto pertence ao perfil.
    perform pg_advisory_xact_lock(hashtextextended((item_json ->> 'profileId'), 0));
    resolved_execute_at := nullif(item_json ->> 'executeAt', '')::timestamptz;

    if resolved_execute_at is null and nullif(item_json ->> 'scheduleTime', '') is not null then
      -- Cada janela usa apenas os nove minutos posteriores ao horário-base.
      -- Ex.: 12:00 procura 12:01–12:09; quando cheia, 12:11–12:19.
      candidate_window_start := (timezone('America/Sao_Paulo', now())::date + (item_json ->> 'scheduleTime')::time) at time zone 'America/Sao_Paulo';
      -- Se a janela-base inteira já passou, preserva a semântica de "próximo
      -- dia livre". A partir de uma janela válida, a capacidade esgotada avança
      -- em blocos de dez minutos no mesmo dia.
      if candidate_window_start + interval '9 minutes 59 seconds' <= timezone('utc', now()) then
        candidate_window_start := candidate_window_start + interval '1 day';
      end if;
      loop
        select candidate.minute_start into candidate_minute
        from (
          select candidate_window_start + make_interval(mins => minute_offset) as minute_start
          from generate_series(1, 9) as minute_offset
        ) as candidate
        where candidate.minute_start > timezone('utc', now())
          and not exists (
            select 1
            from public.publication_items occupied
            where occupied.organization_id = p_organization_id
              and occupied.profile_id = (item_json ->> 'profileId')::uuid
              and date_trunc('minute', occupied.execute_at) = candidate.minute_start
              and occupied.status in ('waiting', 'ready', 'preparing', 'publishing')
          )
        order by random()
        limit 1;

        if candidate_minute is not null then
          resolved_execute_at := candidate_minute + make_interval(secs => floor(random() * 60)::integer);
          exit;
        end if;

        candidate_window_start := candidate_window_start + interval '10 minutes';
      end loop;
    end if;

    -- Data única é preservada; apenas o minuto é verificado para conflito.
    if resolved_execute_at is not null and exists (
      select 1
      from public.publication_items occupied
      where occupied.organization_id = p_organization_id
        and occupied.profile_id = (item_json ->> 'profileId')::uuid
        and date_trunc('minute', occupied.execute_at) = date_trunc('minute', resolved_execute_at)
        and occupied.status in ('waiting', 'ready', 'preparing', 'publishing')
    ) then
      raise exception using errcode = 'P0001', message = 'minute_slot_conflict';
    end if;

    insert into public.publication_items (
      organization_id, batch_id, profile_id, format, status, execute_at, caption, idempotency_key
    ) values (
      p_organization_id, batch_row.id, (item_json ->> 'profileId')::uuid,
      (item_json ->> 'format')::public.publication_format,
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
  if new.execute_at is not null and new.status in ('waiting', 'ready', 'preparing', 'publishing') then
    perform pg_advisory_xact_lock(hashtextextended(new.profile_id::text, 0));
    if exists (
      select 1
      from public.publication_items occupied
      where occupied.organization_id = new.organization_id
        and occupied.profile_id = new.profile_id
        and date_trunc('minute', occupied.execute_at) = date_trunc('minute', new.execute_at)
        and occupied.status in ('waiting', 'ready', 'preparing', 'publishing')
        and occupied.id <> new.id
    ) then
      raise exception using errcode = '23505', message = 'active_publication_minute_conflict';
    end if;
  end if;
  return new;
end;
$$;
