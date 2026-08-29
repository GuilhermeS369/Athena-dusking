-- A migration 323 trocou os cursores linha-a-linha de cancel_publication_queue_scope
-- por instruções orientadas a conjunto, mas um teste com 20.000 itens sintéticos
-- (organização isolada, apagada depois) mostrou que isso não basta sozinho: a
-- tabela publication_items tem ~20 índices, e uma única UPDATE mudando 6 colunas
-- em 20 mil linhas precisa manter todos eles — só essa manutenção de índice já
-- passa dos ~8s de statement_timeout, independente de a mutação ser em lote ou
-- por cursor. statement_timeout limita o tempo de UM statement/transação; a
-- única forma de fazer mais trabalho do que cabe em 8s é dividir em várias
-- chamadas separadas, cada uma com seu próprio orçamento de tempo.
--
-- Esta migration adiciona um caminho em blocos: quando o escopo tem mais itens
-- cancelaveis do que cabe com folga numa chamada (1500), cada execução da RPC
-- cancela só o próximo bloco e devolve a operação como 'running' com progresso
-- real — o polling de 3s que a UI já tem chama de novo automaticamente até
-- esvaziar. Escopos pequenos (o caso comum) continuam exatamente como estavam,
-- concluindo numa única chamada.

create or replace function public.cancel_publication_queue_scope_chunk(
  p_scope text,
  p_target_id uuid,
  p_chunk_size integer default 1500
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_organization_id uuid;
  target_profile_ids uuid[];
  locked_blocking_count integer := 0;
  cancelled_this_chunk integer := 0;
  affected_batch_ids uuid[] := '{}'::uuid[];
  remaining_cancelable_items integer := 0;
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

  -- Trava até p_chunk_size dos itens mais antigos do escopo (cancelaveis OU em
  -- processamento). Se algum estiver em preparing/publishing, esta chamada não
  -- cancela nada agora — a operação continua 'running' e o próximo poll de 3s
  -- tenta de novo (o item tende a sair de processamento sozinho).
  with candidate as (
    select item_inner.id, item_inner.status
    from public.publication_items as item_inner
    where item_inner.organization_id = target_organization_id
      and (
        (p_scope = 'batch' and item_inner.batch_id = p_target_id)
        or (p_scope <> 'batch' and item_inner.profile_id = any(target_profile_ids))
      )
      and item_inner.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended')
    order by item_inner.created_at, item_inner.id
    limit p_chunk_size
    for update
  )
  select count(*) filter (where candidate.status in ('preparing', 'publishing'))::integer
  into locked_blocking_count
  from candidate;

  if locked_blocking_count > 0 then
    select count(*)::integer into remaining_cancelable_items
    from public.publication_items item_source
    where item_source.organization_id = target_organization_id
      and (
        (p_scope = 'batch' and item_source.batch_id = p_target_id)
        or (p_scope <> 'batch' and item_source.profile_id = any(target_profile_ids))
      )
      and item_source.status in ('waiting', 'ready', 'failed', 'suspended');
    return jsonb_build_object('chunkState', 'blocked', 'cancelledThisChunk', 0, 'remainingCancelableItems', remaining_cancelable_items);
  end if;

  -- Nenhuma das linhas travadas acima está em preparing/publishing (checado
  -- agora mesmo, sob lock); logo, todas pertencem ao conjunto cancelável e esta
  -- segunda consulta — mesma ordenação/limite, mesma transação — seleciona
  -- exatamente as mesmas linhas para efetivamente cancelá-las.
  with candidate as (
    select item_inner.id, item_inner.batch_id, item_inner.status as previous_status
    from public.publication_items as item_inner
    where item_inner.organization_id = target_organization_id
      and (
        (p_scope = 'batch' and item_inner.batch_id = p_target_id)
        or (p_scope <> 'batch' and item_inner.profile_id = any(target_profile_ids))
      )
      and item_inner.status in ('waiting', 'ready', 'failed', 'suspended')
    order by item_inner.created_at, item_inner.id
    limit p_chunk_size
    for update
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

  select count(*)::integer into remaining_cancelable_items
  from public.publication_items item_source
  where item_source.organization_id = target_organization_id
    and (
      (p_scope = 'batch' and item_source.batch_id = p_target_id)
      or (p_scope <> 'batch' and item_source.profile_id = any(target_profile_ids))
    )
    and item_source.status in ('waiting', 'ready', 'failed', 'suspended');

  return jsonb_build_object('chunkState', 'processed', 'cancelledThisChunk', cancelled_this_chunk, 'remainingCancelableItems', remaining_cancelable_items);
end;
$$;

revoke all on function public.cancel_publication_queue_scope_chunk(text, uuid, integer) from public, anon, authenticated;
grant execute on function public.cancel_publication_queue_scope_chunk(text, uuid, integer) to service_role;

create or replace function public.execute_server_publication_queue_cancellation(
  p_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  operation_row public.publication_queue_cancellation_operations%rowtype;
  traditional_result jsonb;
  compact_result jsonb;
  final_result jsonb;
  affected_batch_id uuid;
  target_organization_id uuid;
  target_profile_ids uuid[];
  cancelable_count integer;
  chunk_result jsonb;
  total_at_start integer;
  cancelled_so_far integer;
  new_progress integer;
begin
  select * into operation_row
  from public.publication_queue_cancellation_operations
  where id = p_operation_id
  for update;

  if operation_row.id is null then
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

  -- Mede o volume ainda pendente com uma consulta agregada barata para decidir
  -- entre concluir numa única chamada (comportamento inalterado) ou processar
  -- só o próximo bloco e devolver 'running' com progresso real.
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

  cancelable_count := 0;
  if target_organization_id is not null then
    select count(*)::integer into cancelable_count
    from public.publication_items item_source
    where item_source.organization_id = target_organization_id
      and (
        (operation_row.scope = 'batch' and item_source.batch_id = operation_row.target_id)
        or (operation_row.scope <> 'batch' and item_source.profile_id = any(target_profile_ids))
      )
      and item_source.status in ('waiting', 'ready', 'failed', 'suspended');
  end if;

  if cancelable_count > 1500 then
    chunk_result := public.cancel_publication_queue_scope_chunk(operation_row.scope, operation_row.target_id, 1500);

    total_at_start := coalesce((operation_row.result ->> 'totalCancelableItemsAtStart')::integer, cancelable_count);
    cancelled_so_far := coalesce((operation_row.result ->> 'cancelledSoFar')::integer, 0)
      + coalesce((chunk_result ->> 'cancelledThisChunk')::integer, 0);
    new_progress := greatest(5, least(95, round(100.0 * cancelled_so_far / greatest(total_at_start, 1))::integer));

    update public.publication_queue_cancellation_operations
    set progress = new_progress,
        result = jsonb_build_object(
          'state', 'running',
          'totalCancelableItemsAtStart', total_at_start,
          'cancelledSoFar', cancelled_so_far,
          'remainingCancelableItems', coalesce((chunk_result ->> 'remainingCancelableItems')::integer, cancelable_count),
          'lastChunkBlocked', coalesce((chunk_result ->> 'chunkState') = 'blocked', false)
        )
    where id = operation_row.id;

    return jsonb_build_object(
      'state', 'running',
      'operationId', operation_row.id,
      'progress', new_progress,
      'cancelledSoFar', cancelled_so_far,
      'remainingCancelableItems', coalesce((chunk_result ->> 'remainingCancelableItems')::integer, cancelable_count)
    );
  end if;

  -- Escopo pequeno o bastante para concluir numa única chamada — mesmo
  -- comportamento de antes desta migration.
  traditional_result := public.cancel_publication_queue_scope(operation_row.scope, operation_row.target_id);

  if traditional_result ->> 'state' = 'blocked' then
    final_result := traditional_result || jsonb_build_object('operationId', operation_row.id);
    update public.publication_queue_cancellation_operations
    set status = 'blocked', progress = 100, result = final_result,
        completed_at = timezone('utc', now())
    where id = operation_row.id;
    return final_result;
  end if;

  -- Esta rotina cancela e verifica chunks, perfis, horizontes e planos do
  -- gerador compacto. Qualquer falha reverte também a mutação tradicional.
  compact_result := public.execute_publication_queue_cancellation(operation_row.id);

  -- Uma versão anterior marcava todos os lotes da organização que tivessem ao
  -- menos um item cancelado. Recalcular os lotes do escopo e qualquer lote
  -- cancelado que ainda tenha item ativo corrige também esse efeito colateral.
  for affected_batch_id in
    select distinct candidate.batch_id
    from (
      select item.batch_id
      from public.publication_items item
      where item.organization_id = operation_row.organization_id
        and (
          (operation_row.scope = 'batch' and item.batch_id = operation_row.target_id)
          or (operation_row.scope = 'account' and item.profile_id = operation_row.target_id)
          or (operation_row.scope = 'group' and exists (
            select 1 from public.profile_group_members member
            where member.organization_id = operation_row.organization_id
              and member.group_id = operation_row.target_id
              and member.profile_id = item.profile_id
          ))
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

  -- Soma o que já havia sido cancelado em blocos por chamadas anteriores desta
  -- mesma operação (guardado em operation.result) ao que esta última chamada
  -- concluiu, para o total reportado ao usuário refletir a operação inteira.
  final_result := compact_result || jsonb_build_object(
    'operationId', operation_row.id,
    'cancelledItems', coalesce((traditional_result ->> 'cancelledItems')::integer, 0)
      + coalesce((operation_row.result ->> 'cancelledSoFar')::integer, 0),
    'remainingActiveItems', coalesce((traditional_result ->> 'remainingActiveItems')::integer, 0),
    'cancelledGenerationJobs', coalesce((traditional_result ->> 'cancelledGenerationJobs')::integer, 0),
    'excludedGenerationJobs', coalesce((traditional_result ->> 'excludedGenerationJobs')::integer, 0),
    'verified', coalesce((traditional_result ->> 'verified')::boolean, false)
      and coalesce((compact_result ->> 'verified')::boolean, false)
  );

  if not coalesce((final_result ->> 'verified')::boolean, false) then
    raise exception using errcode = 'P0001', message = 'A verificação final não confirmou o cancelamento completo.';
  end if;

  update public.publication_queue_cancellation_operations
  set status = 'completed', progress = 100, result = final_result,
      error_message = null, completed_at = timezone('utc', now())
  where id = operation_row.id;
  return final_result;
end;
$$;

revoke all on function public.execute_server_publication_queue_cancellation(uuid) from public, anon, authenticated;
grant execute on function public.execute_server_publication_queue_cancellation(uuid) to service_role;

notify pgrst, 'reload schema';
