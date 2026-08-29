-- Corrige o cancelamento de fila que ficava preso em "5%" para escopos grandes
-- (ex.: grupo com centenas de contas e milhares de itens ativos). A causa raiz
-- era um cursor PL/pgSQL que processava um item por vez (1 update + 2 deletes +
-- 1 insert de auditoria por item); para ~15 mil itens isso nunca terminava
-- dentro do statement_timeout do Postgres (medido: abortava em ~8,8s com
-- "57014 canceling statement due to statement timeout"), e a transação inteira
-- revertia sem gravar nenhum progresso, repetindo para sempre a cada poll da UI.
--
-- Esta migration reescreve as duas etapas custosas de cancel_publication_queue_scope
-- como instruções únicas orientadas a conjunto (bloqueio via agregação com FOR
-- UPDATE em subconsulta, cancelamento via UPDATE/DELETE/INSERT encadeados em
-- WITH), preservando exatamente as mesmas garantias de segurança: nenhum item
-- em preparing/publishing é tocado, e a operação inteira é abortada (state =
-- 'blocked') se qualquer item do escopo já estiver em processamento.
--
-- Também evita que cliques repetidos no mesmo alvo criem operações duráveis
-- duplicadas: begin_publication_queue_cancellation agora reaproveita uma
-- operação já 'running' para o mesmo (organização, escopo, alvo) em vez de
-- sempre criar uma nova linha. O índice único abaixo fecha a janela de corrida
-- remanescente (dois cliques verdadeiramente simultâneos) no nível do banco;
-- confirmado antes de criar que não há hoje nenhuma duplicata que o violaria.
create unique index if not exists publication_queue_cancellation_operations_one_running_per_target
on public.publication_queue_cancellation_operations (organization_id, scope, target_id)
where status = 'running';

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

-- Evita operações duráveis duplicadas para o mesmo alvo: se já existe uma
-- operação 'running' para (organização, escopo, alvo), reaproveita-a em vez
-- de criar uma segunda linha concorrente com outra idempotency_key. Foi assim
-- que o incidente de 2026-08-29 acabou com duas operações presas ao mesmo
-- tempo para o mesmo grupo.
create or replace function public.begin_publication_queue_cancellation(
  p_scope text,
  p_target_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_organization_id uuid;
  operation_row public.publication_queue_cancellation_operations%rowtype;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'Autenticação necessária.';
  end if;
  if p_scope not in ('account', 'batch', 'group') then
    raise exception using errcode = '22023', message = 'Escopo de cancelamento inválido.';
  end if;
  if char_length(trim(coalesce(p_idempotency_key, ''))) not between 16 and 240 then
    raise exception using errcode = '22023', message = 'Chave de idempotência inválida.';
  end if;

  if p_scope = 'batch' then
    select batch_row.organization_id into current_organization_id
    from public.publication_batches batch_row where batch_row.id = p_target_id;
  elsif p_scope = 'account' then
    select profile_row.organization_id into current_organization_id
    from public.instagram_profiles profile_row where profile_row.id = p_target_id and profile_row.deleted_at is null;
  else
    select group_row.organization_id into current_organization_id
    from public.profile_groups group_row where group_row.id = p_target_id and group_row.deleted_at is null;
  end if;
  if current_organization_id is null then
    raise exception using errcode = 'P0002', message = 'Destino de cancelamento não encontrado.';
  end if;
  if not public.has_organization_role(current_organization_id, array['admin', 'operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  select * into operation_row
  from public.publication_queue_cancellation_operations
  where organization_id = current_organization_id
    and scope = p_scope
    and target_id = p_target_id
    and status = 'running'
  order by created_at desc
  limit 1
  for update;

  if operation_row.id is not null then
    return jsonb_build_object(
      'id', operation_row.id, 'status', operation_row.status, 'progress', operation_row.progress,
      'result', operation_row.result, 'error_message', operation_row.error_message,
      'completed_at', operation_row.completed_at, 'created_at', operation_row.created_at
    );
  end if;

  insert into public.publication_queue_cancellation_operations (
    organization_id, requested_by, idempotency_key, scope, target_id
  ) values (
    current_organization_id, auth.uid(), trim(p_idempotency_key), p_scope, p_target_id
  ) on conflict (organization_id, idempotency_key) do nothing;

  select * into operation_row
  from public.publication_queue_cancellation_operations
  where organization_id = current_organization_id and idempotency_key = trim(p_idempotency_key)
  for update;

  if operation_row.requested_by <> auth.uid() then
    raise exception using errcode = '42501', message = 'A chave de idempotência pertence a outro usuário.';
  end if;
  return jsonb_build_object(
    'id', operation_row.id, 'status', operation_row.status, 'progress', operation_row.progress,
    'result', operation_row.result, 'error_message', operation_row.error_message,
    'completed_at', operation_row.completed_at, 'created_at', operation_row.created_at
  );
end;
$$;

revoke all on function public.begin_publication_queue_cancellation(text, uuid, text) from public, anon, authenticated;
grant execute on function public.begin_publication_queue_cancellation(text, uuid, text) to authenticated;

notify pgrst, 'reload schema';
