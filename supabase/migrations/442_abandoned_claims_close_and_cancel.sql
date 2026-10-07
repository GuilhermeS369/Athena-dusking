-- 442 — claim abandonado deixa de ficar preso em 'preparing' e de travar o
-- cancelamento em massa.
--
-- O QUE ESTAVA ERRADO. Em 06/10/2026 a VPS ficou sem alcancar o Supabase por
-- alguns segundos em tres momentos (11:14, 14:17 e 17:11 BRT; ConnectTimeout de
-- 10 s). O publicador 1 tinha acabado de reivindicar 6, 2 e 3 reels e nao
-- conseguiu gravar nem o resultado nem o adiamento de infraestrutura ("Nao foi
-- possivel persistir o retry de infraestrutura; o lease sera recuperado"). O
-- lease (900 s no spool) venceu DEPOIS do corte de atraso de 300 s, entao:
--
--   * claim_publication_items (405/425/426) os exclui pela trava de atraso;
--   * expire_late_publication_items so encerrava 'waiting'/'ready' e 'failed'
--     com retry (426) -- nao 'preparing';
--   * o cancelamento em massa (428) conta todo 'preparing'/'publishing' como
--     "em voo", sem olhar o lease.
--
-- Resultado: 11 itens 'preparing' para sempre (Pomodoro 8, Vini 2, Aurora 1),
-- sem contêiner na Meta, e na "Vini farmando cash" dois cancelamentos do grupo
-- "Tia Laura 2.0" em 07/10 ficaram 30 minutos em "Aguardando 2 em envio" e
-- fecharam com "2 ainda em envio" -- nada estava sendo enviado. E o mesmo
-- buraco que a 426 fechou para 'failed', agora para 'preparing'.
--
-- O QUE MUDA.
--   1. expire_late_publication_items encerra tambem 'preparing' sem creation_id,
--      com lease vencido e alem do corte do formato: ignored +
--      publication_past_due, como qualquer vencido. Dentro da janela do formato
--      (story: 1 h com attempt_count < 5) o claim continua retomando o item.
--   2. cancel_publication_queue_scope_chunk cancela tambem o claim abandonado
--      ('preparing'/'publishing', sem creation_id, lease vencido) e so conta
--      como em voo o item com lease vigente ou com contêiner criado.
--   3. execute_server_publication_queue_cancellation conta do mesmo jeito e
--      manda o claim abandonado pelo bloco.
--
-- Item com creation_id nao muda em nenhum dos tres: o claim o retoma com
-- prioridade para confirmar, e o cancelamento continua esperando por ele.
--
-- Corpos identicos aos de producao (pg_get_functiondef em 07/10/2026) fora dos
-- trechos marcados com 442. Nenhuma coluna, indice, gatilho ou grant novo;
-- a varredura continua servida por publication_items_unstarted_current_claim_idx
-- (que ja inclui 'preparing').

set lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.expire_late_publication_items(p_limit integer DEFAULT 500)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  lateness_seconds integer;
  cutoff timestamptz;
  expired_count integer := 0;
  lateness_by_format jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Somente service_role pode encerrar publicações vencidas.';
  end if;
  if p_limit not between 1 and 5000 then
    raise exception using errcode = '22023', message = 'Limite inválido.';
  end if;

  select min(settings.max_publication_lateness_seconds) into lateness_seconds
  from public.publication_rate_limit_settings settings
  where settings.enabled
    and settings.max_publication_lateness_seconds is not null;

  if lateness_seconds is null then
    return jsonb_build_object('expired', 0, 'disabled', true);
  end if;
  cutoff := timezone('utc', now()) - make_interval(secs => lateness_seconds);

  -- 426: mesma janela por formato do claim.
  select coalesce(jsonb_object_agg(fmt.key, fmt.min_value), '{}'::jsonb) into lateness_by_format
  from (
    select kv.key, min((kv.value)::integer) as min_value
    from public.publication_rate_limit_settings settings,
         jsonb_each_text(coalesce(settings.max_publication_lateness_seconds_by_format, '{}'::jsonb)) kv
    where settings.enabled
    group by kv.key
  ) fmt;

  with alvos as (
    select item.id, item.status as previous_status
    from public.publication_items item
    where item.archived_at is null
      -- 426: tambem a falha RETRYAVEL cujo retry venceu depois do corte. Antes ela
      -- ficava 'failed' para sempre: o claim a excluia pelo corte e nada a encerrava
      -- (22 stories em 09/09/2026, 06:20Z).
      and (
        item.status in ('waiting', 'ready')
        or (item.status = 'failed' and item.next_attempt_at is not null)
        -- 442: claim abandonado. O publicador reivindicou ('preparing'), nao
        -- conseguiu gravar nem o resultado nem o adiamento (rede fora) e o lease
        -- venceu depois do corte: o claim o exclui pela trava de atraso e nada o
        -- encerrava (11 reels em 06/10/2026). O filtro de lease vencido abaixo
        -- vale para todos; item com creation_id segue com o claim.
        or item.status = 'preparing'
      )
      and item.creation_id is null
      and item.execute_at is not null
      and item.execute_at < cutoff
      -- 426: formato com janela propria so vence depois da janela ou sem tentativa.
      and not (
        (lateness_by_format ->> item.format::text) is not null
        and item.attempt_count < 5
        and item.execute_at >= timezone('utc', now())
          - make_interval(secs => (lateness_by_format ->> item.format::text)::integer)
      )
      and (item.lease_until is null or item.lease_until <= timezone('utc', now()))
      and (item.dispatch_staged_until is null or item.dispatch_staged_until <= timezone('utc', now()))
    order by item.execute_at, item.id
    limit p_limit
    for update skip locked
  ), encerrados as (
    update public.publication_items item set
      status = 'ignored', claimed_by = null, lease_until = null, next_attempt_at = null,
      dispatch_staged_by = null, dispatch_staged_at = null, dispatch_staged_until = null,
      last_error_code = 'publication_past_due',
      last_error_message = 'Passou do horário agendado; não é publicada atrasada.'
    from alvos
    where item.id = alvos.id
    returning item.id, item.organization_id, item.status, alvos.previous_status
  ), eventos as (
    insert into public.publication_item_events (
      organization_id, publication_item_id, event_type, previous_status,
      status, actor_label, error_code, error_message, metadata
    )
    select encerrados.organization_id, encerrados.id, 'ignored', encerrados.previous_status, 'ignored',
      'system: past-due', 'publication_past_due',
      'Passou do horário agendado; não é publicada atrasada.',
      jsonb_build_object('cutoff_at', cutoff, 'lateness_seconds', lateness_seconds)
    from encerrados
    returning publication_item_id
  )
  select count(*)::integer into expired_count from encerrados;

  delete from public.publication_profile_daily_reservations reservation
  using public.publication_items item
  where reservation.publication_item_id = item.id
    and item.status = 'ignored'
    and item.last_error_code = 'publication_past_due';

  delete from public.publication_dispatch_rate_reservations reservation
  using public.publication_items item
  where reservation.publication_item_id = item.id
    and item.status = 'ignored'
    and item.last_error_code = 'publication_past_due';

  return jsonb_build_object('expired', expired_count, 'cutoffAt', cutoff, 'latenessSeconds', lateness_seconds);
end;
$function$;

CREATE OR REPLACE FUNCTION public.cancel_publication_queue_scope_chunk(p_scope text, p_target_id uuid, p_chunk_size integer DEFAULT 1500)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  target_organization_id uuid;
  target_profile_ids uuid[];
  cancelled_this_chunk integer := 0;
  affected_batch_ids uuid[] := '{}'::uuid[];
  remaining_cancelable_items integer := 0;
  in_flight_items integer := 0;
  affected_batch_id uuid;
  discard_count integer;
begin
  if p_scope not in ('account', 'batch', 'group') then
    raise exception using errcode = '22023', message = 'Escopo de cancelamento inválido.';
  end if;
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'Autenticação necessária.';
  end if;

  if p_scope = 'batch' then
    select batch_row.organization_id into target_organization_id
    from public.publication_batches batch_row where batch_row.id = p_target_id;
    if target_organization_id is null then
      raise exception using errcode = 'P0002', message = 'Lote de publicação não encontrado.';
    end if;
  elsif p_scope = 'account' then
    select profile_row.organization_id, array[profile_row.id] into target_organization_id, target_profile_ids
    from public.instagram_profiles profile_row
    where profile_row.id = p_target_id and profile_row.deleted_at is null;
    if target_organization_id is null then
      raise exception using errcode = 'P0002', message = 'Perfil não encontrado.';
    end if;
  else
    select group_row.organization_id into target_organization_id
    from public.profile_groups group_row where group_row.id = p_target_id and group_row.deleted_at is null;
    if target_organization_id is null then
      raise exception using errcode = 'P0002', message = 'Grupo não encontrado.';
    end if;
    select coalesce(array_agg(member.profile_id order by member.profile_id), '{}'::uuid[])
    into target_profile_ids
    from public.profile_group_members member
    where member.organization_id = target_organization_id and member.group_id = p_target_id;
  end if;

  if not public.has_organization_role(target_organization_id, array['admin', 'operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  with candidate as (
    select item_inner.id, item_inner.batch_id, item_inner.status as previous_status
    from public.publication_items as item_inner
    where item_inner.organization_id = target_organization_id
      and (
        (p_scope = 'batch' and item_inner.batch_id = p_target_id)
        or (p_scope <> 'batch' and item_inner.profile_id = any(target_profile_ids))
      )
      and item_inner.archived_at is null
      -- 442: claim abandonado (lease vencido, sem contêiner) tambem e cancelavel.
      -- Nao esta em voo: ninguem tem o lease, e quem ainda estiver com ele na
      -- mao perde no proximo passo (P0002) antes de publicar.
      and (
        item_inner.status in ('waiting', 'ready', 'failed', 'suspended')
        or (
          item_inner.status in ('preparing', 'publishing')
          and item_inner.creation_id is null
          and (item_inner.lease_until is null or item_inner.lease_until <= timezone('utc', now()))
        )
      )
    order by item_inner.created_at, item_inner.id
    limit p_chunk_size
    for update skip locked
  ), cancelled as (
    update public.publication_items as item_outer
    set status = 'cancelled', cancelled_at = timezone('utc', now()), next_attempt_at = null,
        lease_until = null, claimed_by = null, creation_id = null
    from candidate
    where item_outer.id = candidate.id
    returning item_outer.id, item_outer.batch_id
  ), deleted_daily as (
    delete from public.publication_profile_daily_reservations as reservation
    using candidate
    where reservation.publication_item_id = candidate.id
    returning 1
  ), deleted_rate as (
    delete from public.publication_dispatch_rate_reservations as reservation
    using candidate
    where reservation.publication_item_id = candidate.id
    returning 1
  ), logged as (
    insert into public.publication_item_events (
      organization_id, publication_item_id, event_type, previous_status, status,
      actor_user_id, actor_label, metadata
    )
    select target_organization_id, candidate.id, 'cancelled'::public.publication_item_event_type,
      candidate.previous_status, 'cancelled'::public.publication_item_status,
      auth.uid(), auth.jwt() ->> 'email',
      jsonb_build_object('action', 'cancelled_queue_scope_by_user', 'scope', p_scope, 'target_id', p_target_id, 'chunked', true)
    from candidate
    returning 1
  )
  select
    (select count(*) from cancelled)::integer,
    coalesce((select array_agg(distinct batch_id) from cancelled), '{}'::uuid[]),
    (select count(*) from deleted_daily)::integer + (select count(*) from deleted_rate)::integer + (select count(*) from logged)::integer
  into cancelled_this_chunk, affected_batch_ids, discard_count;

  for affected_batch_id in
    select distinct affected.batch_id from unnest(affected_batch_ids) as affected(batch_id)
  loop
    perform public.sync_publication_batch_status(affected_batch_id);
  end loop;

  select
    -- 442: em voo e so o item com lease vigente ou com contêiner criado.
    count(*) filter (
      where item_source.status in ('waiting', 'ready', 'failed', 'suspended')
        or (
          item_source.status in ('preparing', 'publishing')
          and item_source.creation_id is null
          and (item_source.lease_until is null or item_source.lease_until <= timezone('utc', now()))
        )
    )::integer,
    count(*) filter (
      where item_source.status in ('preparing', 'publishing')
        and not (
          item_source.creation_id is null
          and (item_source.lease_until is null or item_source.lease_until <= timezone('utc', now()))
        )
    )::integer
  into remaining_cancelable_items, in_flight_items
  from public.publication_items item_source
  where item_source.organization_id = target_organization_id
    and (
      (p_scope = 'batch' and item_source.batch_id = p_target_id)
      or (p_scope <> 'batch' and item_source.profile_id = any(target_profile_ids))
    )
    and item_source.archived_at is null
    and item_source.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended');

  return jsonb_build_object(
    'chunkState', 'processed',
    'cancelledThisChunk', cancelled_this_chunk,
    'remainingCancelableItems', remaining_cancelable_items,
    'inFlightItems', in_flight_items
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.execute_server_publication_queue_cancellation(p_operation_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  operation_row public.publication_queue_cancellation_operations%rowtype;
  traditional_result jsonb;
  compact_result jsonb;
  sources_result jsonb;
  final_result jsonb;
  affected_batch_id uuid;
  target_organization_id uuid;
  target_profile_ids uuid[];
  cancelable_count integer := 0;
  in_flight_count integer := 0;
  abandoned_count integer := 0;
  chunk_result jsonb;
  total_at_start integer;
  cancelled_so_far integer;
  new_progress integer;
  deadline_reached boolean := false;
begin
  -- `skip locked`: quem chega enquanto outro executor (worker ou navegador)
  -- está no meio de um bloco recebe `busy` e volta depois, em vez de enfileirar
  -- atrás de um statement de vários segundos.
  select * into operation_row
  from public.publication_queue_cancellation_operations
  where id = p_operation_id
  for update skip locked;

  if operation_row.id is null then
    if exists (select 1 from public.publication_queue_cancellation_operations where id = p_operation_id) then
      return jsonb_build_object('state', 'busy', 'operationId', p_operation_id);
    end if;
    raise exception using errcode = 'P0002', message = 'Operação de cancelamento não encontrada.';
  end if;
  if operation_row.status <> 'running' then
    return operation_row.result || jsonb_build_object(
      'operationId', operation_row.id,
      'operationStatus', operation_row.status
    );
  end if;

  -- A rota administrativa já validou organização, usuário e papel. Repor os
  -- claims do solicitante permite reutilizar as rotinas consolidadas e mantém
  -- ator, eventos e auditoria associados ao usuário correto.
  perform set_config('request.jwt.claim.sub', operation_row.requested_by::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', operation_row.requested_by, 'role', 'authenticated')::text,
    true
  );

  if operation_row.scope = 'batch' then
    select batch_row.organization_id into target_organization_id
    from public.publication_batches batch_row where batch_row.id = operation_row.target_id;
  elsif operation_row.scope = 'account' then
    select profile_row.organization_id, array[profile_row.id] into target_organization_id, target_profile_ids
    from public.instagram_profiles profile_row
    where profile_row.id = operation_row.target_id and profile_row.deleted_at is null;
  else
    select group_row.organization_id into target_organization_id
    from public.profile_groups group_row where group_row.id = operation_row.target_id and group_row.deleted_at is null;
    if target_organization_id is not null then
      select coalesce(array_agg(member.profile_id), '{}'::uuid[]) into target_profile_ids
      from public.profile_group_members member
      where member.organization_id = target_organization_id and member.group_id = operation_row.target_id;
    end if;
  end if;

  -- Alvo apagado no meio do caminho: encerra a operação como falha em vez de
  -- levantar erro a cada tick para sempre.
  if target_organization_id is null then
    final_result := operation_row.result || jsonb_build_object('state', 'failed', 'operationId', operation_row.id);
    update public.publication_queue_cancellation_operations
    set status = 'failed', progress = 100, result = final_result,
        error_message = 'Destino de cancelamento não encontrado.',
        completed_at = timezone('utc', now()), last_chunk_at = timezone('utc', now())
    where id = operation_row.id;
    return final_result;
  end if;

  select
    -- 442: claim abandonado (lease vencido, sem contêiner) conta como cancelavel,
    -- nao como em voo. Antes a operacao esperava 30 minutos por um item que
    -- ninguem estava enviando e fechava com "ainda em envio".
    count(*) filter (
      where item_source.status in ('waiting', 'ready', 'failed', 'suspended')
        or (
          item_source.status in ('preparing', 'publishing')
          and item_source.creation_id is null
          and (item_source.lease_until is null or item_source.lease_until <= timezone('utc', now()))
        )
    )::integer,
    count(*) filter (
      where item_source.status in ('preparing', 'publishing')
        and not (
          item_source.creation_id is null
          and (item_source.lease_until is null or item_source.lease_until <= timezone('utc', now()))
        )
    )::integer,
    count(*) filter (
      where item_source.status in ('preparing', 'publishing')
          and item_source.creation_id is null
          and (item_source.lease_until is null or item_source.lease_until <= timezone('utc', now()))
    )::integer
  into cancelable_count, in_flight_count, abandoned_count
  from public.publication_items item_source
  where item_source.organization_id = target_organization_id
    and (
      (operation_row.scope = 'batch' and item_source.batch_id = operation_row.target_id)
      or (operation_row.scope <> 'batch' and item_source.profile_id = any(target_profile_ids))
    )
    and item_source.archived_at is null
    and item_source.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended');

  -- Fontes primeiro, uma vez só por operação: sem isto o gerador continua
  -- materializando itens para o mesmo alvo enquanto os blocos correm.
  if operation_row.result ->> 'sourcesCancelledAt' is null then
    sources_result := public.cancel_publication_queue_scope_sources(operation_row.scope, operation_row.target_id);
    operation_row.result := operation_row.result || sources_result || jsonb_build_object(
      'sourcesCancelledAt', timezone('utc', now()),
      'totalCancelableItemsAtStart', coalesce((operation_row.result ->> 'totalCancelableItemsAtStart')::integer, cancelable_count)
    );
    update public.publication_queue_cancellation_operations
    set result = operation_row.result
    where id = operation_row.id;
  end if;

  total_at_start := coalesce((operation_row.result ->> 'totalCancelableItemsAtStart')::integer, cancelable_count);
  cancelled_so_far := coalesce((operation_row.result ->> 'cancelledSoFar')::integer, 0);

  -- Bloco: escopo grande, ou qualquer escopo com item em voo (o caminho pequeno
  -- abortaria; o bloco não).
  -- 442: claim abandonado tambem vai pelo bloco; o caminho pequeno trava e
  -- devolve 'blocked' para qualquer 'preparing'.
  if cancelable_count > 1500 or (cancelable_count > 0 and (in_flight_count > 0 or abandoned_count > 0)) then
    chunk_result := public.cancel_publication_queue_scope_chunk(operation_row.scope, operation_row.target_id, 1500);

    cancelled_so_far := cancelled_so_far + coalesce((chunk_result ->> 'cancelledThisChunk')::integer, 0);
    new_progress := greatest(5, least(95, round(100.0 * cancelled_so_far / greatest(total_at_start, 1))::integer));

    update public.publication_queue_cancellation_operations
    set progress = new_progress,
        last_chunk_at = timezone('utc', now()),
        result = operation_row.result || jsonb_build_object(
          'state', 'running',
          'cancelledSoFar', cancelled_so_far,
          'remainingCancelableItems', coalesce((chunk_result ->> 'remainingCancelableItems')::integer, cancelable_count),
          'inFlightItems', coalesce((chunk_result ->> 'inFlightItems')::integer, in_flight_count),
          'waitingForInFlight', false
        )
    where id = operation_row.id;

    return jsonb_build_object(
      'state', 'running',
      'operationId', operation_row.id,
      'progress', new_progress,
      'cancelledSoFar', cancelled_so_far,
      'remainingCancelableItems', coalesce((chunk_result ->> 'remainingCancelableItems')::integer, cancelable_count),
      'inFlightItems', coalesce((chunk_result ->> 'inFlightItems')::integer, in_flight_count)
    );
  end if;

  -- Nada cancelável, mas ainda há item em voo: espera terminar (o lease é de
  -- minutos). Se voltar como falha ou aguardando, a próxima etapa cancela.
  -- Passados 30 minutos, encerra sem verificação e registra o que sobrou.
  if cancelable_count = 0 and in_flight_count > 0 then
    if timezone('utc', now()) - operation_row.created_at <= interval '30 minutes' then
      update public.publication_queue_cancellation_operations
      set progress = 95,
          last_chunk_at = timezone('utc', now()),
          result = operation_row.result || jsonb_build_object(
            'state', 'running', 'cancelledSoFar', cancelled_so_far,
            'remainingCancelableItems', 0, 'inFlightItems', in_flight_count, 'waitingForInFlight', true
          )
      where id = operation_row.id;
      return jsonb_build_object(
        'state', 'running', 'operationId', operation_row.id, 'progress', 95,
        'cancelledSoFar', cancelled_so_far, 'remainingCancelableItems', 0, 'inFlightItems', in_flight_count
      );
    end if;
    deadline_reached := true;
  end if;

  if not deadline_reached then
    -- Caminho pequeno de sempre (<= 1500 canceláveis, nada em voo na contagem).
    traditional_result := public.cancel_publication_queue_scope(operation_row.scope, operation_row.target_id);

    -- Corrida: o publicador reivindicou algo entre a contagem e a trava. Não é
    -- erro nem bloqueio terminal: a próxima etapa passa pelo bloco.
    if traditional_result ->> 'state' = 'blocked' then
      update public.publication_queue_cancellation_operations
      set progress = greatest(operation_row.progress, 5),
          last_chunk_at = timezone('utc', now()),
          result = operation_row.result || jsonb_build_object(
            'state', 'running', 'cancelledSoFar', cancelled_so_far,
            'inFlightItems', coalesce((traditional_result ->> 'blockedItems')::integer, 1), 'waitingForInFlight', true
          )
      where id = operation_row.id;
      return jsonb_build_object('state', 'running', 'operationId', operation_row.id, 'progress', operation_row.progress);
    end if;

    compact_result := public.execute_publication_queue_cancellation(operation_row.id);
    if compact_result ->> 'state' = 'blocked' then
      update public.publication_queue_cancellation_operations
      set status = 'running', progress = greatest(operation_row.progress, 5), completed_at = null,
          last_chunk_at = timezone('utc', now()),
          result = operation_row.result || jsonb_build_object(
            'state', 'running', 'cancelledSoFar', cancelled_so_far,
            'inFlightItems', coalesce((compact_result ->> 'blockedItems')::integer, 1), 'waitingForInFlight', true
          )
      where id = operation_row.id;
      return jsonb_build_object('state', 'running', 'operationId', operation_row.id, 'progress', operation_row.progress);
    end if;
  else
    traditional_result := jsonb_build_object(
      'state', 'cancelled', 'cancelledItems', 0, 'remainingActiveItems', in_flight_count,
      'verified', false, 'cancelledGenerationJobs', 0, 'excludedGenerationJobs', 0
    );
    compact_result := jsonb_build_object('state', 'cancelled', 'verified', false);
  end if;

  -- Recalcula os lotes do escopo e qualquer lote 'cancelled' que ainda tenha
  -- item ativo (efeito colateral da versão antiga da passada compacta).
  for affected_batch_id in
    select distinct candidate.batch_id
    from (
      select item.batch_id
      from public.publication_items item
      where item.organization_id = operation_row.organization_id
        and item.archived_at is null
        and (
          (operation_row.scope = 'batch' and item.batch_id = operation_row.target_id)
          or (operation_row.scope <> 'batch' and item.profile_id = any(target_profile_ids))
        )
      union
      select batch.id
      from public.publication_batches batch
      where batch.organization_id = operation_row.organization_id
        and batch.status = 'cancelled'
        and exists (
          select 1 from public.publication_items item
          where item.batch_id = batch.id
            and item.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended')
        )
    ) candidate
  loop
    perform public.sync_publication_batch_status(affected_batch_id);
  end loop;

  final_result := operation_row.result || compact_result || jsonb_build_object(
    'state', 'cancelled',
    'operationId', operation_row.id,
    'cancelledItems', coalesce((traditional_result ->> 'cancelledItems')::integer, 0) + cancelled_so_far,
    'cancelledSoFar', coalesce((traditional_result ->> 'cancelledItems')::integer, 0) + cancelled_so_far,
    'remainingCancelableItems', 0,
    'remainingActiveItems', coalesce((traditional_result ->> 'remainingActiveItems')::integer, 0),
    'inFlightItems', case when deadline_reached then in_flight_count else 0 end,
    'inFlightItemsLeft', case when deadline_reached then in_flight_count else 0 end,
    'waitingForInFlight', false,
    'deadlineReached', deadline_reached,
    'cancelledGenerationJobs', coalesce((operation_row.result ->> 'cancelledGenerationJobs')::integer, 0)
      + coalesce((traditional_result ->> 'cancelledGenerationJobs')::integer, 0),
    'excludedGenerationJobs', coalesce((operation_row.result ->> 'excludedGenerationJobs')::integer, 0)
      + coalesce((traditional_result ->> 'excludedGenerationJobs')::integer, 0),
    'verified', coalesce((traditional_result ->> 'verified')::boolean, false)
      and coalesce((compact_result ->> 'verified')::boolean, false)
  );

  -- Sem prazo esgotado, "não verificado" só acontece se algo entrou em voo
  -- entre a contagem e a mutação: espera, não falha.
  if not deadline_reached and not coalesce((final_result ->> 'verified')::boolean, false) then
    update public.publication_queue_cancellation_operations
    set progress = 95,
        last_chunk_at = timezone('utc', now()),
        result = operation_row.result || jsonb_build_object(
          'state', 'running',
          'cancelledSoFar', coalesce((traditional_result ->> 'cancelledItems')::integer, 0) + cancelled_so_far,
          'inFlightItems', coalesce((traditional_result ->> 'remainingActiveItems')::integer, 1),
          'waitingForInFlight', true
        )
    where id = operation_row.id;
    return jsonb_build_object('state', 'running', 'operationId', operation_row.id, 'progress', 95);
  end if;

  update public.publication_queue_cancellation_operations
  set status = 'completed', progress = 100, result = final_result,
      error_message = case when deadline_reached
        then format('%s publicação(ões) ainda em envio após 30 minutos; terminam sozinhas.', in_flight_count)
        else null end,
      completed_at = timezone('utc', now()), last_chunk_at = timezone('utc', now())
  where id = operation_row.id;
  return final_result;
end;
$function$;

notify pgrst, 'reload schema';

