-- Cancelar fila/lote/grupo deixa de reescrever itens já arquivados.
--
-- O QUE ESTAVA ERRADO. Os predicados de cancelamento selecionam por status e
-- nunca olharam `archived_at`. Arquivar não muda o status: um item arquivado
-- em 'failed' continua sendo 'failed'. Logo, todo item já arquivado e ainda
-- dentro da retenção de 7 dias da 333 entrava no escopo do cancelamento.
--
-- Isso era quase invisível enquanto arquivar era um ato manual e raro. Depois
-- do commit 1eb7202 (29/08/2026), que pôs o arquivamento em laço a cada 10
-- minutos, a tabela quente passou a manter permanentemente até 7 dias de itens
-- arquivados — e todos eles viraram alvo do botão.
--
-- CONSEQUÊNCIAS EM TELA, todas com a mesma causa:
--
--  1. O número reportado ao usuário fica errado. Um perfil com 3 itens ativos e
--     20 mil falhas arquivadas na semana devolvia "20.003 publicações
--     canceladas". O operador pediu para interromper 3.
--  2. `cancelable_count` conta os mesmos 20 mil, estoura o corte de 1.500 e
--     manda uma operação trivial para o caminho fragmentado: ~14 rodadas de
--     3 s de polling, ~45 s de modal aberto, 20 mil UPDATEs e 20 mil linhas
--     novas em `publication_item_events` — para cancelar 3 itens.
--  3. `sync_publication_batch_status` é chamada para cada lote tocado, e ela lê
--     TODOS os itens do lote, arquivados inclusive. Um lote histórico de 50
--     publicadas + 2 falhas arquivadas era 'completed_with_errors'; depois de
--     as 2 virarem 'cancelled' ele passa a 'completed'. Um lote cujos itens
--     falharam todos vira 'cancelled'. Histórico reescrito sem ninguém pedir.
--
-- A REGRA. Item arquivado está fora da fila operacional por definição — é o
-- mesmo predicado que `get_publication_queue_reference_page` usa para montar a
-- tela, e a própria limpeza já registra o reconhecimento da falha ao arquivar.
-- Cancelar é uma ação sobre o que ainda vai acontecer; o que já saiu da fila
-- não pode ser alvo. As três funções abaixo são as da 323/324, sem nenhuma
-- outra alteração além de `archived_at is null` nos oito predicados de escopo.

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
      and item_inner.archived_at is null
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
      and item_source.archived_at is null
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
      and item_inner.archived_at is null
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
    and item_source.archived_at is null
    and item_source.status in ('waiting', 'ready', 'failed', 'suspended');

  return jsonb_build_object('chunkState', 'processed', 'cancelledThisChunk', cancelled_this_chunk, 'remainingCancelableItems', remaining_cancelable_items);
end;
$$;

revoke all on function public.cancel_publication_queue_scope_chunk(text, uuid, integer) from public, anon, authenticated;
grant execute on function public.cancel_publication_queue_scope_chunk(text, uuid, integer) to service_role;

create or replace function public.cancel_publication_queue_scope(
  p_scope text,
  p_target_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_organization_id uuid;
  target_profile_ids uuid[];
  target_profile_count integer := 0;
  job_row public.publication_generation_jobs%rowtype;
  blocked_item_ids uuid[] := '{}'::uuid[];
  blocked_item_count integer := 0;
  cancelled_item_count integer := 0;
  affected_batch_ids uuid[] := '{}'::uuid[];
  cancelled_generation_jobs integer := 0;
  excluded_generation_jobs integer := 0;
  remaining_active_items integer := 0;
  job_has_remaining_profiles boolean;
  existing_excluded_profile_ids text[];
  affected_batch_id uuid;
  deleted_daily_reservations integer := 0;
  deleted_rate_reservations integer := 0;
  logged_events integer := 0;
begin
  if p_scope not in ('account', 'batch', 'group') then
    raise exception using errcode = '22023', message = 'Escopo de cancelamento inválido.';
  end if;

  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'Autenticação necessária.';
  end if;

  if p_scope = 'batch' then
    select batch_row.organization_id
    into target_organization_id
    from public.publication_batches as batch_row
    where batch_row.id = p_target_id
    for update;

    if target_organization_id is null then
      raise exception using errcode = 'P0002', message = 'Lote de publicação não encontrado.';
    end if;
  elsif p_scope = 'account' then
    select profile_row.organization_id, array[profile_row.id]
    into target_organization_id, target_profile_ids
    from public.instagram_profiles as profile_row
    where profile_row.id = p_target_id
      and profile_row.deleted_at is null
    for update;

    if target_organization_id is null then
      raise exception using errcode = 'P0002', message = 'Perfil não encontrado.';
    end if;
  else
    select group_row.organization_id
    into target_organization_id
    from public.profile_groups as group_row
    where group_row.id = p_target_id
      and group_row.deleted_at is null
    for update;

    if target_organization_id is null then
      raise exception using errcode = 'P0002', message = 'Grupo não encontrado.';
    end if;

    select coalesce(array_agg(member.profile_id order by member.profile_id), '{}'::uuid[])
    into target_profile_ids
    from public.profile_group_members as member
    where member.organization_id = target_organization_id
      and member.group_id = p_target_id;
  end if;

  if not public.has_organization_role(target_organization_id, array['admin', 'operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  if p_scope <> 'batch' then
    target_profile_count := coalesce(array_length(target_profile_ids, 1), 0);
    if target_profile_count = 0 then
      return jsonb_build_object(
        'state', 'cancelled',
        'scope', p_scope,
        'cancelledItems', 0,
        'remainingActiveItems', 0,
        'verified', true,
        'cancelledGenerationJobs', 0,
        'excludedGenerationJobs', 0
      );
    end if;
  end if;

  -- Mantém a ordem de lock do worker de geração: chunks antes de job. Caso um
  -- chunk já esteja em execução, esta transação espera seu commit, cancela os
  -- itens que ele acabou de materializar e só então altera os chunks restantes.
  perform 1
  from public.publication_generation_job_chunks as chunk_row
  join public.publication_generation_jobs as generation_job on generation_job.id = chunk_row.job_id
  where generation_job.organization_id = target_organization_id
    and generation_job.status in ('queued', 'processing', 'paused', 'failed')
    and chunk_row.status in ('queued', 'processing', 'failed')
    and (
      (p_scope = 'batch' and generation_job.batch_id = p_target_id)
      or (
        p_scope <> 'batch'
        and exists (
          select 1
          from jsonb_array_elements(coalesce(chunk_row.payload, '[]'::jsonb)) as payload_item(value)
          where payload_item.value ->> 'profileId' = any(target_profile_ids::text[])
        )
      )
    )
  order by chunk_row.chunk_index, chunk_row.id
  for update of chunk_row;

  -- Checagem de bloqueio orientada a conjunto: uma única consulta agregada,
  -- sem cursor, que também trava (FOR UPDATE, dentro da subconsulta) todas as
  -- linhas do escopo pelo restante desta transação. Isso preserva a garantia
  -- original — nenhum worker consegue reivindicar lease em um item do escopo
  -- enquanto decidimos bloquear ou cancelar — sem iterar item a item.
  select
    count(*) filter (where item_source.status in ('preparing', 'publishing'))::integer,
    coalesce(array_agg(item_source.id) filter (where item_source.status in ('preparing', 'publishing')), '{}'::uuid[])
  into blocked_item_count, blocked_item_ids
  from (
    select item_inner.id, item_inner.status
    from public.publication_items as item_inner
    where item_inner.organization_id = target_organization_id
      and (
        (p_scope = 'batch' and item_inner.batch_id = p_target_id)
        or (p_scope <> 'batch' and item_inner.profile_id = any(target_profile_ids))
      )
      and item_inner.archived_at is null
      and item_inner.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended')
    for update
  ) as item_source;

  if blocked_item_count > 0 then
    return jsonb_build_object(
      'state', 'blocked',
      'scope', p_scope,
      'blockedItemIds', to_jsonb(blocked_item_ids),
      'blockedItems', blocked_item_count,
      'message', 'Há publicação(ões) já em processamento. Nenhum item foi cancelado; aguarde a finalização e tente novamente.'
    );
  end if;

  -- Para lote, o job inteiro pertence ao lote e precisa ser encerrado. Para
  -- conta/grupo, conservamos o job para os demais perfis e gravamos a exclusão
  -- que também é respeitada pelo materializador e pelos workers de chunk.
  -- (Volume tipicamente baixo: mantido como laço, sem impacto no timeout.)
  for job_row in
    select generation_job.*
    from public.publication_generation_jobs as generation_job
    where generation_job.organization_id = target_organization_id
      and generation_job.status in ('queued', 'processing', 'paused', 'failed')
      and (
        (p_scope = 'batch' and generation_job.batch_id = p_target_id)
        or (
          p_scope <> 'batch'
          and (
            exists (
              select 1
              from jsonb_array_elements(coalesce(generation_job.payload -> 'items', '[]'::jsonb)) as payload_item(value)
              where payload_item.value ->> 'profileId' = any(target_profile_ids::text[])
            )
            or exists (
              select 1
              from public.publication_generation_job_chunks as chunk_row
              where chunk_row.job_id = generation_job.id
                and chunk_row.status in ('queued', 'processing', 'failed')
                and exists (
                  select 1
                  from jsonb_array_elements(coalesce(chunk_row.payload, '[]'::jsonb)) as payload_item(value)
                  where payload_item.value ->> 'profileId' = any(target_profile_ids::text[])
                )
            )
          )
        )
      )
    order by generation_job.created_at, generation_job.id
    for update
  loop
    select exists (
      select 1
      from jsonb_array_elements(coalesce(job_row.payload -> 'items', '[]'::jsonb)) as payload_item(value)
      where p_scope <> 'batch'
        and not (payload_item.value ->> 'profileId' = any(target_profile_ids::text[]))
    ) or exists (
      select 1
      from public.publication_generation_job_chunks as chunk_row
      cross join lateral jsonb_array_elements(coalesce(chunk_row.payload, '[]'::jsonb)) as payload_item(value)
      where chunk_row.job_id = job_row.id
        and chunk_row.status in ('queued', 'processing', 'failed')
        and p_scope <> 'batch'
        and not (payload_item.value ->> 'profileId' = any(target_profile_ids::text[]))
    ) into job_has_remaining_profiles;

    if p_scope = 'batch' or not job_has_remaining_profiles then
      update public.publication_generation_job_chunks
      set status = 'cancelled', claimed_by = null, lease_until = null,
          completed_at = coalesce(completed_at, timezone('utc', now())), last_error_message = null
      where job_id = job_row.id
        and status in ('queued', 'processing', 'failed');

      update public.publication_generation_jobs
      set status = 'cancelled', claimed_by = null, lease_until = null,
          completed_at = timezone('utc', now()), last_error_message = null,
          metadata = metadata || jsonb_build_object(
            'cancelled_at', timezone('utc', now()),
            'cancelled_by', auth.jwt() ->> 'email',
            'cancelled_by_user_id', auth.uid(),
            'cancelled_scope', p_scope
          )
      where id = job_row.id;

      cancelled_generation_jobs := cancelled_generation_jobs + 1;
    else
      select coalesce(array_agg(distinct excluded.profile_id), '{}'::text[])
      into existing_excluded_profile_ids
      from (
        select jsonb_array_elements_text(coalesce(job_row.metadata -> 'cancelled_profile_ids', '[]'::jsonb)) as profile_id
        union
        select unnest(target_profile_ids::text[]) as profile_id
      ) as excluded;

      update public.publication_generation_jobs
      set payload = jsonb_set(
            coalesce(payload, '{}'::jsonb),
            '{items}',
            coalesce((
              select jsonb_agg(payload_item.value)
              from jsonb_array_elements(coalesce(payload -> 'items', '[]'::jsonb)) as payload_item(value)
              where not (payload_item.value ->> 'profileId' = any(target_profile_ids::text[]))
            ), '[]'::jsonb),
            true
          ),
          metadata = jsonb_set(
            coalesce(metadata, '{}'::jsonb),
            '{cancelled_profile_ids}',
            to_jsonb(existing_excluded_profile_ids),
            true
          ) || jsonb_build_object(
            'last_scoped_cancellation_at', timezone('utc', now()),
            'last_scoped_cancellation_by', auth.jwt() ->> 'email'
          )
      where id = job_row.id;

      -- Esses chunks já estão travados acima. Remover o perfil do payload
      -- impede que um worker gere novos itens para a conta cancelada.
      update public.publication_generation_job_chunks as chunk_row
      set payload = coalesce((
        select jsonb_agg(payload_item.value)
        from jsonb_array_elements(coalesce(chunk_row.payload, '[]'::jsonb)) as payload_item(value)
        where not (payload_item.value ->> 'profileId' = any(target_profile_ids::text[]))
      ), '[]'::jsonb)
      where chunk_row.job_id = job_row.id
        and chunk_row.status in ('queued', 'processing', 'failed')
        and exists (
          select 1
          from jsonb_array_elements(coalesce(chunk_row.payload, '[]'::jsonb)) as payload_item(value)
          where payload_item.value ->> 'profileId' = any(target_profile_ids::text[])
        );

      excluded_generation_jobs := excluded_generation_jobs + 1;
    end if;
  end loop;

  -- Cancelamento orientado a conjunto: uma única cadeia de UPDATE/DELETE/INSERT
  -- via WITH, em vez de um cursor com 4 instruções por item. Todas as etapas
  -- são referenciadas na consulta final para garantir que o planejador do
  -- Postgres execute cada uma delas (CTEs de escrita não referenciadas podem
  -- não ser avaliadas).
  with cancel_target as (
    select item_inner.id, item_inner.batch_id, item_inner.status as previous_status
    from public.publication_items as item_inner
    where item_inner.organization_id = target_organization_id
      and (
        (p_scope = 'batch' and item_inner.batch_id = p_target_id)
        or (p_scope <> 'batch' and item_inner.profile_id = any(target_profile_ids))
      )
      and item_inner.archived_at is null
      and item_inner.status in ('waiting', 'ready', 'failed', 'suspended')
  ), cancelled as (
    update public.publication_items as item_outer
    set status = 'cancelled',
        cancelled_at = timezone('utc', now()),
        next_attempt_at = null,
        lease_until = null,
        claimed_by = null,
        creation_id = null
    from cancel_target
    where item_outer.id = cancel_target.id
    returning item_outer.id, item_outer.batch_id
  ), deleted_daily as (
    delete from public.publication_profile_daily_reservations as reservation
    using cancel_target
    where reservation.publication_item_id = cancel_target.id
    returning 1
  ), deleted_rate as (
    delete from public.publication_dispatch_rate_reservations as reservation
    using cancel_target
    where reservation.publication_item_id = cancel_target.id
    returning 1
  ), logged as (
    insert into public.publication_item_events (
      organization_id, publication_item_id, event_type, previous_status, status,
      actor_user_id, actor_label, metadata
    )
    select target_organization_id, cancel_target.id, 'cancelled'::public.publication_item_event_type,
      cancel_target.previous_status, 'cancelled'::public.publication_item_status,
      auth.uid(), auth.jwt() ->> 'email',
      jsonb_build_object('action', 'cancelled_queue_scope_by_user', 'scope', p_scope, 'target_id', p_target_id)
    from cancel_target
    returning 1
  )
  select
    (select count(*) from cancelled)::integer,
    coalesce((select array_agg(distinct batch_id) from cancelled), '{}'::uuid[]),
    (select count(*) from deleted_daily)::integer,
    (select count(*) from deleted_rate)::integer,
    (select count(*) from logged)::integer
  into cancelled_item_count, affected_batch_ids, deleted_daily_reservations, deleted_rate_reservations, logged_events;

  for affected_batch_id in
    select distinct affected.batch_id
    from unnest(affected_batch_ids) as affected(batch_id)
  loop
    perform public.sync_publication_batch_status(affected_batch_id);
  end loop;

  select count(*)::integer
  into remaining_active_items
  from public.publication_items as item_source
  where item_source.organization_id = target_organization_id
    and (
      (p_scope = 'batch' and item_source.batch_id = p_target_id)
      or (p_scope <> 'batch' and item_source.profile_id = any(target_profile_ids))
    )
    and item_source.archived_at is null
    and item_source.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended');

  return jsonb_build_object(
    'state', 'cancelled',
    'scope', p_scope,
    'cancelledItems', cancelled_item_count,
    'remainingActiveItems', remaining_active_items,
    'verified', remaining_active_items = 0,
    'cancelledGenerationJobs', cancelled_generation_jobs,
    'excludedGenerationJobs', excluded_generation_jobs
  );
end;
$$;

revoke all on function public.cancel_publication_queue_scope(text, uuid) from public, anon;
grant execute on function public.cancel_publication_queue_scope(text, uuid) to authenticated;

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
      and item_source.archived_at is null
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
