-- A recorrência exibida no compositor trabalha por horário-base diário.
-- Se qualquer minuto aleatório da janela de dez minutos já estiver ocupado
-- para o perfil, a próxima recorrência deve avançar para o próximo dia desse
-- mesmo horário-base, e não reaproveitar outro minuto da mesma janela.
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
  schedule_base_at timestamptz;
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
    -- A trava e a ocupação são sempre por perfil, nunca por formato nem lote.
    perform pg_advisory_xact_lock(hashtextextended((item_json ->> 'profileId'), 0));
    resolved_execute_at := nullif(item_json ->> 'executeAt', '')::timestamptz;
    schedule_base_at := nullif(item_json ->> 'scheduleBaseAt', '')::timestamptz;

    if resolved_execute_at is null and nullif(item_json ->> 'scheduleTime', '') is not null then
      -- A data do plano é a referência da recorrência. Para payloads legados,
      -- sem scheduleBaseAt, mantém-se o comportamento de começar no dia atual.
      candidate_window_start := (
        coalesce(schedule_base_at at time zone 'America/Sao_Paulo', timezone('America/Sao_Paulo', now()))::date
        + (item_json ->> 'scheduleTime')::time
      ) at time zone 'America/Sao_Paulo';

      -- Um plano pode ficar aberto por algum tempo antes da confirmação. Avança
      -- até a primeira janela ainda futura sem mudar a regra de uma janela por dia.
      while candidate_window_start + interval '9 minutes 59 seconds' <= timezone('utc', now()) loop
        candidate_window_start := candidate_window_start + interval '1 day';
      end loop;

      loop
        if not exists (
          select 1
          from public.publication_items occupied
          where occupied.organization_id = p_organization_id
            and occupied.profile_id = (item_json ->> 'profileId')::uuid
            and occupied.execute_at >= candidate_window_start
            and occupied.execute_at < candidate_window_start + interval '10 minutes'
            and occupied.status in ('waiting', 'ready', 'preparing', 'publishing')
        ) then
          select candidate.minute_start into candidate_minute
          from (
            -- O horário-base é um marcador de faixa; as vagas reais continuam em xx:01 a xx:09.
            select candidate_window_start + make_interval(mins => minute_offset) as minute_start
            from generate_series(1, 9) as minute_offset
          ) as candidate
          where candidate.minute_start > timezone('utc', now())
          order by random()
          limit 1;

          if candidate_minute is not null then
            resolved_execute_at := candidate_minute + make_interval(secs => floor(random() * 60)::integer);
            exit;
          end if;
        end if;

        -- Qualquer publicação na janela diária ocupa aquele horário-base para
        -- o perfil; a próxima tentativa vai para o mesmo horário no dia seguinte.
        candidate_window_start := candidate_window_start + interval '1 day';
      end loop;
    end if;

    -- Data única é literal. O bloqueio por minuto, independente de formato,
    -- permanece inalterado e produz o erro que a interface já destaca em vermelho.
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

revoke all on function public.queue_publication_batch(uuid, text, timestamptz, jsonb) from public, anon;
grant execute on function public.queue_publication_batch(uuid, text, timestamptz, jsonb) to authenticated;
