-- Fila de cancelamento: cancelar grupo/lote/perfil vira uma operação durável que
-- o servidor avança sozinho, e a tela passa a mostrar "Cancelada".
--
-- O QUE ESTAVA ERRADO (incidente de 14/09/2026, organização Pomodoro: três
-- grupos cancelados em sequência; o primeiro parou em 2.146 itens ativos com
-- 9.000 cancelados, e as linhas apareceram como "Concluído").
--
--  1. Só o navegador avançava os blocos de 1.500. A tela guardava UMA operação;
--     clicar no segundo grupo sobrescrevia a primeira, e o restante dela nunca
--     era retomado. Agora um worker na VPS drena as operações `running`; o
--     navegador é reserva e só avança operação parada há mais de 15 s.
--  2. O bloco travava os 1.500 itens mais antigos INCLUINDO preparing/publishing
--     e, se um estivesse em voo, não cancelava nada naquela rodada. Num grupo
--     quente com quatro publicadores quase sempre há item em voo: o cancelamento
--     não andava. Decisão do dono (14/09): cancela o que não está em voo; o que
--     está sendo enviado termina sozinho; a operação só fecha quando não sobrar
--     nada em voo nem cancelável, com prazo de 30 minutos para os que sobrarem.
--  3. `execute_publication_queue_cancellation` (última versão na 197, nunca
--     tocada por 323/324/336) ainda cancelava itens ARQUIVADOS (sem
--     `archived_at is null`) — dezenas de milhares de falhas arquivadas estouravam
--     o statement_timeout, a RPC devolvia 503 e a operação ficava `running` para
--     sempre — e marcava TODOS os lotes da organização com um item cancelado
--     como `cancelled`. Os dois saem daqui.
--  4. As fontes (jobs de geração e planos compactos) só eram canceladas no
--     caminho final pequeno; enquanto os blocos corriam, o gerador seguia
--     materializando itens para o mesmo grupo. Agora são canceladas na
--     primeira chamada, antes de qualquer bloco.
--  5. A operação era travada com `for update` sem `skip locked`: um segundo
--     chamador esperava o bloco inteiro. Agora devolve `busy` na hora, o que
--     permite worker e navegador coexistirem sem duplicar trabalho.
--  6. O tom da linha na tela não tinha ramo `cancelled`: sem item ativo caía em
--     `else 'done'` ("Concluído"), e a linha 100% cancelada sem publicadas no dia
--     sumia da lista. Agora existe o tom `cancelled`, e a linha de um alvo com
--     cancelamento concluído na janela do histórico fica visível mesmo zerada.
--
-- Tudo aqui é `create or replace`; para reverter, reaplicar os corpos da 336
-- (chunk, executor), 197 (compacta), 418 (resumo) e 323 (begin).

-- ---------------------------------------------------------------------------
-- 1. Esquema
-- ---------------------------------------------------------------------------

alter table public.publication_queue_cancellation_operations
  add column if not exists target_label text,
  add column if not exists last_chunk_at timestamptz;

comment on column public.publication_queue_cancellation_operations.target_label is
  'Nome do alvo no momento do pedido (@perfil, nome do lote ou do grupo). Existe para a lista de operações e a linha sintética do resumo não precisarem consultar as tabelas de origem.';
comment on column public.publication_queue_cancellation_operations.last_chunk_at is
  'Última vez que um executor (worker ou navegador) avançou esta operação. O navegador só avança operação parada há mais de 15 s.';

-- O worker drena a operação parada há mais tempo primeiro: nenhuma morre de fome.
create index if not exists publication_queue_cancellation_operations_running_drain_idx
  on public.publication_queue_cancellation_operations (updated_at, id)
  where status = 'running';

-- Tom "cancelled" no resumo: a operação concluída mais recente por alvo.
create index if not exists publication_queue_cancellation_operations_recent_target_idx
  on public.publication_queue_cancellation_operations (organization_id, scope, target_id, completed_at desc)
  where status = 'completed';

-- ---------------------------------------------------------------------------
-- 2. Invalidar o resumo materializado sem recalculá-lo no caminho da requisição
--
-- O worker de resumo da VPS (poll de 20 s) recalcula o que está mais velho que
-- QUEUE_SUMMARY_MAX_AGE_SECONDS. Empurrar `computed_at` uma hora para trás faz a
-- organização entrar no próximo tick. Não há cron na Vercel para isso, por
-- decisão do dono (commit 810ff1d).
-- ---------------------------------------------------------------------------

create or replace function public.invalidate_publication_queue_summary(
  p_organization_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not public.is_organization_member(p_organization_id) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  update public.publication_queue_summary_totals
  set computed_at = least(computed_at, timezone('utc', now()) - interval '1 hour')
  where organization_id = p_organization_id;
end;
$$;

revoke all on function public.invalidate_publication_queue_summary(uuid) from public, anon;
grant execute on function public.invalidate_publication_queue_summary(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. begin: igual à 323, gravando o rótulo do alvo
-- ---------------------------------------------------------------------------

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
  current_target_label text;
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
    select batch_row.organization_id, coalesce(batch_row.name, 'Sem campanha')
    into current_organization_id, current_target_label
    from public.publication_batches batch_row where batch_row.id = p_target_id;
  elsif p_scope = 'account' then
    select profile_row.organization_id, '@' || profile_row.username
    into current_organization_id, current_target_label
    from public.instagram_profiles profile_row where profile_row.id = p_target_id and profile_row.deleted_at is null;
  else
    select group_row.organization_id, group_row.name
    into current_organization_id, current_target_label
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
      'completed_at', operation_row.completed_at, 'created_at', operation_row.created_at,
      'updated_at', operation_row.updated_at, 'last_chunk_at', operation_row.last_chunk_at,
      'scope', operation_row.scope, 'target_id', operation_row.target_id, 'target_label', operation_row.target_label
    );
  end if;

  insert into public.publication_queue_cancellation_operations (
    organization_id, requested_by, idempotency_key, scope, target_id, target_label
  ) values (
    current_organization_id, auth.uid(), trim(p_idempotency_key), p_scope, p_target_id, current_target_label
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
    'completed_at', operation_row.completed_at, 'created_at', operation_row.created_at,
    'updated_at', operation_row.updated_at, 'last_chunk_at', operation_row.last_chunk_at,
    'scope', operation_row.scope, 'target_id', operation_row.target_id, 'target_label', operation_row.target_label
  );
end;
$$;

revoke all on function public.begin_publication_queue_cancellation(text, uuid, text) from public, anon, authenticated;
grant execute on function public.begin_publication_queue_cancellation(text, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Fontes: jobs de geração e planos compactos, cancelados ANTES dos blocos
--
-- Corpo extraído, sem lógica nova, do laço de jobs de cancel_publication_queue_scope
-- (336) e do bloco compacto de execute_publication_queue_cancellation (197).
-- Idempotente: os predicados só alcançam linhas ainda não canceladas, então o
-- caminho final pequeno repetir os mesmos statements não faz nada.
-- ---------------------------------------------------------------------------

create or replace function public.cancel_publication_queue_scope_sources(
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
  target_profile_ids uuid[] := '{}'::uuid[];
  job_row public.publication_generation_jobs%rowtype;
  job_has_remaining_profiles boolean;
  existing_excluded_profile_ids text[];
  cancelled_generation_jobs integer := 0;
  excluded_generation_jobs integer := 0;
  compact_plan_id uuid;
  compact_chunks_cancelled integer := 0;
  compact_profiles_cancelled integer := 0;
  compact_horizons_released integer := 0;
  compact_plans_cancelled integer := 0;
begin
  if p_scope not in ('account', 'batch', 'group') then
    raise exception using errcode = '22023', message = 'Escopo de cancelamento inválido.';
  end if;

  if p_scope = 'batch' then
    select batch_row.organization_id into target_organization_id
    from public.publication_batches batch_row where batch_row.id = p_target_id;
  elsif p_scope = 'account' then
    select profile_row.organization_id, array[profile_row.id] into target_organization_id, target_profile_ids
    from public.instagram_profiles profile_row
    where profile_row.id = p_target_id and profile_row.deleted_at is null;
  else
    select group_row.organization_id into target_organization_id
    from public.profile_groups group_row where group_row.id = p_target_id and group_row.deleted_at is null;
    if target_organization_id is not null then
      select coalesce(array_agg(member.profile_id order by member.profile_id), '{}'::uuid[])
      into target_profile_ids
      from public.profile_group_members member
      where member.organization_id = target_organization_id and member.group_id = p_target_id;
    end if;
  end if;
  if target_organization_id is null then
    raise exception using errcode = 'P0002', message = 'Destino de cancelamento não encontrado.';
  end if;
  if p_scope <> 'batch' and coalesce(array_length(target_profile_ids, 1), 0) = 0 then
    return jsonb_build_object(
      'cancelledGenerationJobs', 0, 'excludedGenerationJobs', 0,
      'compactChunksCancelled', 0, 'compactProfilesCancelled', 0,
      'compactHorizonsReleased', 0, 'compactPlansCancelled', 0
    );
  end if;

  -- Mantém a ordem de lock do worker de geração: chunks antes de job.
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

  -- Planos compactos (rotação em massa): chunks, perfis do plano, horizontes, plano.
  update public.bulk_publication_generation_chunks chunk_row
  set status = 'cancelled', claimed_by = null, lease_until = null,
      completed_at = coalesce(chunk_row.completed_at, timezone('utc', now())),
      last_error_message = 'Cancelado pela fila operacional.'
  from public.bulk_publication_plans plan_row
  where plan_row.id = chunk_row.plan_id
    and plan_row.organization_id = target_organization_id
    and ((p_scope = 'batch' and plan_row.batch_id = p_target_id) or (p_scope <> 'batch' and chunk_row.profile_id = any(target_profile_ids)))
    and chunk_row.status in ('queued', 'processing', 'failed', 'paused');
  get diagnostics compact_chunks_cancelled = row_count;

  update public.bulk_publication_plan_profiles plan_profile
  set status = 'cancelled', suspended_at = coalesce(plan_profile.suspended_at, timezone('utc', now())),
      suspension_reason = 'Cancelado pela fila operacional.'
  from public.bulk_publication_plans plan_row
  where plan_row.id = plan_profile.plan_id
    and plan_row.organization_id = target_organization_id
    and ((p_scope = 'batch' and plan_row.batch_id = p_target_id) or (p_scope <> 'batch' and plan_profile.profile_id = any(target_profile_ids)))
    and plan_profile.status in ('queued', 'generating', 'suspended', 'failed');
  get diagnostics compact_profiles_cancelled = row_count;

  update public.bulk_publication_profile_horizons horizon
  set status = 'cancelled', released_at = coalesce(horizon.released_at, timezone('utc', now()))
  from public.bulk_publication_plans plan_row
  where plan_row.id = horizon.plan_id
    and plan_row.organization_id = target_organization_id
    and ((p_scope = 'batch' and plan_row.batch_id = p_target_id) or (p_scope <> 'batch' and horizon.profile_id = any(target_profile_ids)))
    and horizon.status = 'active';
  get diagnostics compact_horizons_released = row_count;

  for compact_plan_id in
    select distinct plan_row.id
    from public.bulk_publication_plans plan_row
    where plan_row.organization_id = target_organization_id
      and (
        (p_scope = 'batch' and plan_row.batch_id = p_target_id)
        or (p_scope <> 'batch' and exists (
          select 1 from public.bulk_publication_plan_profiles profile_plan
          where profile_plan.plan_id = plan_row.id and profile_plan.profile_id = any(target_profile_ids)
        ))
      )
  loop
    if not exists (
      select 1 from public.bulk_publication_plan_profiles profile_plan
      where profile_plan.plan_id = compact_plan_id and profile_plan.status <> 'cancelled'
    ) then
      update public.bulk_publication_plans
      set status = 'cancelled', completed_at = timezone('utc', now()),
          metadata = metadata || jsonb_build_object('cancelled_at', timezone('utc', now()), 'cancelled_by', auth.uid())
      where id = compact_plan_id and status <> 'cancelled';
      if found then compact_plans_cancelled := compact_plans_cancelled + 1; end if;
    else
      perform public.refresh_bulk_rotation_plan_state(compact_plan_id);
    end if;
  end loop;

  return jsonb_build_object(
    'cancelledGenerationJobs', cancelled_generation_jobs,
    'excludedGenerationJobs', excluded_generation_jobs,
    'compactChunksCancelled', compact_chunks_cancelled,
    'compactProfilesCancelled', compact_profiles_cancelled,
    'compactHorizonsReleased', compact_horizons_released,
    'compactPlansCancelled', compact_plans_cancelled
  );
end;
$$;

revoke all on function public.cancel_publication_queue_scope_sources(text, uuid) from public, anon, authenticated;
grant execute on function public.cancel_publication_queue_scope_sources(text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Bloco de 1.500 sem bloqueio por item em voo
--
-- Igual à 336, menos a primeira trava (que incluía preparing/publishing e
-- abortava a rodada) e com `skip locked`: o claim do publicador (425) também usa
-- `skip locked`, então os dois nunca esperam um pelo outro. Um item que o
-- publicador acabou de reivindicar fica para a próxima rodada ou termina sozinho.
-- ---------------------------------------------------------------------------

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
      and item_inner.status in ('waiting', 'ready', 'failed', 'suspended')
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
    count(*) filter (where item_source.status in ('waiting', 'ready', 'failed', 'suspended'))::integer,
    count(*) filter (where item_source.status in ('preparing', 'publishing'))::integer
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
$$;

revoke all on function public.cancel_publication_queue_scope_chunk(text, uuid, integer) from public, anon, authenticated;
grant execute on function public.cancel_publication_queue_scope_chunk(text, uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Passada compacta: igual à 197, só com `archived_at is null` e sem o update
--    de lotes da organização inteira
-- ---------------------------------------------------------------------------

create or replace function public.execute_publication_queue_cancellation(
  p_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  operation_row public.publication_queue_cancellation_operations%rowtype;
  operation_organization_id uuid;
  target_profile_ids uuid[] := '{}'::uuid[];
  item_row public.publication_items%rowtype;
  compact_plan_id uuid;
  cancellation_result jsonb;
  blocked_item_ids uuid[] := '{}'::uuid[];
  compact_chunks_cancelled integer := 0;
  compact_profiles_cancelled integer := 0;
  compact_horizons_released integer := 0;
  compact_plans_cancelled integer := 0;
  compact_remaining_sources integer := 0;
begin
  select * into operation_row from public.publication_queue_cancellation_operations where id = p_operation_id for update;
  if operation_row.id is null then raise exception using errcode = 'P0002', message = 'Operação de cancelamento não encontrada.'; end if;
  if auth.uid() is not null and operation_row.requested_by <> auth.uid() then raise exception using errcode = '42501', message = 'Ação não permitida.'; end if;
  if operation_row.status <> 'running' then return operation_row.result || jsonb_build_object('operationId', operation_row.id, 'operationStatus', operation_row.status); end if;

  operation_organization_id := operation_row.organization_id;
  if auth.uid() is not null and not public.has_organization_role(operation_organization_id, array['admin', 'operator']::public.organization_role[]) then raise exception using errcode = '42501', message = 'Ação não permitida.'; end if;
  if operation_row.scope = 'batch' then
    perform 1 from public.publication_batches batch_row where batch_row.id = operation_row.target_id and batch_row.organization_id = operation_organization_id for update;
    if not found then raise exception using errcode = 'P0002', message = 'Lote de publicação não encontrado.'; end if;
  elsif operation_row.scope = 'account' then
    select array[profile_row.id] into target_profile_ids from public.instagram_profiles profile_row where profile_row.id = operation_row.target_id and profile_row.organization_id = operation_organization_id and profile_row.deleted_at is null for update;
    if target_profile_ids is null then raise exception using errcode = 'P0002', message = 'Perfil não encontrado.'; end if;
  else
    perform 1 from public.profile_groups group_row where group_row.id = operation_row.target_id and group_row.organization_id = operation_organization_id and group_row.deleted_at is null for update;
    if not found then raise exception using errcode = 'P0002', message = 'Grupo não encontrado.'; end if;
    select coalesce(array_agg(member.profile_id order by member.profile_id), '{}'::uuid[]) into target_profile_ids from public.profile_group_members member where member.organization_id = operation_organization_id and member.group_id = operation_row.target_id;
  end if;

  update public.publication_queue_cancellation_operations set progress = 20, result = operation_row.result || jsonb_build_object('state', 'running', 'operationId', operation_row.id) where id = operation_row.id;
  perform 1 from public.bulk_publication_generation_chunks chunk_row join public.bulk_publication_plans plan_row on plan_row.id = chunk_row.plan_id where plan_row.organization_id = operation_organization_id and ((operation_row.scope = 'batch' and plan_row.batch_id = operation_row.target_id) or (operation_row.scope <> 'batch' and chunk_row.profile_id = any(target_profile_ids))) order by chunk_row.created_at, chunk_row.id for update of chunk_row;
  perform 1 from public.bulk_publication_plan_profiles plan_profile join public.bulk_publication_plans plan_row on plan_row.id = plan_profile.plan_id where plan_row.organization_id = operation_organization_id and ((operation_row.scope = 'batch' and plan_row.batch_id = operation_row.target_id) or (operation_row.scope <> 'batch' and plan_profile.profile_id = any(target_profile_ids))) order by plan_profile.created_at, plan_profile.id for update of plan_profile;
  -- Item arquivado está fora da fila por definição (336): não é alvo nem para
  -- travar nem para cancelar. Sem este predicado, dezenas de milhares de falhas
  -- arquivadas entravam aqui e estouravam o statement_timeout.
  for item_row in select item_source.* from public.publication_items item_source where item_source.organization_id = operation_organization_id and ((operation_row.scope = 'batch' and item_source.batch_id = operation_row.target_id) or (operation_row.scope <> 'batch' and item_source.profile_id = any(target_profile_ids))) and item_source.archived_at is null and item_source.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended') order by item_source.created_at, item_source.id for update loop if item_row.status in ('preparing', 'publishing') then blocked_item_ids := array_append(blocked_item_ids, item_row.id); end if; end loop;
  if coalesce(array_length(blocked_item_ids, 1), 0) > 0 then
    cancellation_result := jsonb_build_object('state', 'blocked', 'operationId', operation_row.id, 'blockedItemIds', to_jsonb(blocked_item_ids), 'blockedItems', coalesce(array_length(blocked_item_ids, 1), 0), 'message', 'Há publicação(ões) já em processamento. Nenhum item foi cancelado.');
    update public.publication_queue_cancellation_operations set status = 'blocked', progress = 100, result = cancellation_result, completed_at = timezone('utc', now()) where id = operation_row.id;
    return cancellation_result;
  end if;
  update public.bulk_publication_generation_chunks chunk_row set status = 'cancelled', claimed_by = null, lease_until = null, completed_at = coalesce(chunk_row.completed_at, timezone('utc', now())), last_error_message = 'Cancelado pela fila operacional.' from public.bulk_publication_plans plan_row where plan_row.id = chunk_row.plan_id and plan_row.organization_id = operation_organization_id and ((operation_row.scope = 'batch' and plan_row.batch_id = operation_row.target_id) or (operation_row.scope <> 'batch' and chunk_row.profile_id = any(target_profile_ids))) and chunk_row.status in ('queued', 'processing', 'failed', 'paused'); get diagnostics compact_chunks_cancelled = row_count;
  update public.bulk_publication_plan_profiles plan_profile set status = 'cancelled', suspended_at = coalesce(plan_profile.suspended_at, timezone('utc', now())), suspension_reason = 'Cancelado pela fila operacional.' from public.bulk_publication_plans plan_row where plan_row.id = plan_profile.plan_id and plan_row.organization_id = operation_organization_id and ((operation_row.scope = 'batch' and plan_row.batch_id = operation_row.target_id) or (operation_row.scope <> 'batch' and plan_profile.profile_id = any(target_profile_ids))) and plan_profile.status in ('queued', 'generating', 'suspended', 'failed'); get diagnostics compact_profiles_cancelled = row_count;
  update public.bulk_publication_profile_horizons horizon set status = 'cancelled', released_at = coalesce(horizon.released_at, timezone('utc', now())) from public.bulk_publication_plans plan_row where plan_row.id = horizon.plan_id and plan_row.organization_id = operation_organization_id and ((operation_row.scope = 'batch' and plan_row.batch_id = operation_row.target_id) or (operation_row.scope <> 'batch' and horizon.profile_id = any(target_profile_ids))) and horizon.status = 'active'; get diagnostics compact_horizons_released = row_count;
  for compact_plan_id in select distinct plan_row.id from public.bulk_publication_plans plan_row where plan_row.organization_id = operation_organization_id and ((operation_row.scope = 'batch' and plan_row.batch_id = operation_row.target_id) or (operation_row.scope <> 'batch' and exists (select 1 from public.bulk_publication_plan_profiles profile_plan where profile_plan.plan_id = plan_row.id and profile_plan.profile_id = any(target_profile_ids)))) loop
    if not exists (select 1 from public.bulk_publication_plan_profiles profile_plan where profile_plan.plan_id = compact_plan_id and profile_plan.status <> 'cancelled') then update public.bulk_publication_plans set status = 'cancelled', completed_at = timezone('utc', now()), metadata = metadata || jsonb_build_object('cancelled_at', timezone('utc', now()), 'cancelled_by', coalesce(auth.uid(), operation_row.requested_by)) where id = compact_plan_id and status <> 'cancelled'; if found then compact_plans_cancelled := compact_plans_cancelled + 1; end if; else perform public.refresh_bulk_rotation_plan_state(compact_plan_id); end if;
  end loop;
  update public.publication_queue_cancellation_operations set progress = 65 where id = operation_row.id;
  update public.publication_items item_source
  set status = 'cancelled', cancelled_at = coalesce(item_source.cancelled_at, timezone('utc', now()))
  where item_source.organization_id = operation_organization_id
    and ((operation_row.scope = 'batch' and item_source.batch_id = operation_row.target_id) or (operation_row.scope <> 'batch' and item_source.profile_id = any(target_profile_ids)))
    and item_source.archived_at is null
    and item_source.status in ('waiting', 'ready', 'failed', 'suspended');
  get diagnostics compact_chunks_cancelled = row_count;
  -- A versão da 197 marcava aqui TODOS os lotes da organização com um item
  -- cancelado como 'cancelled'. O executor recalcula os lotes do escopo via
  -- sync_publication_batch_status; nada mais a fazer com lotes aqui.
  cancellation_result := jsonb_build_object(
    'state', 'cancelled',
    'scope', operation_row.scope,
    'cancelledItems', compact_chunks_cancelled,
    'remainingActiveItems', 0,
    'verified', true,
    'cancelledGenerationJobs', 0,
    'excludedGenerationJobs', 0
  );
  select count(*)::integer into compact_remaining_sources from public.bulk_publication_generation_chunks chunk_row join public.bulk_publication_plans plan_row on plan_row.id = chunk_row.plan_id join public.bulk_publication_plan_profiles profile_plan on profile_plan.id = chunk_row.plan_profile_id where plan_row.organization_id = operation_organization_id and plan_row.status in ('queued', 'generating', 'paused') and profile_plan.status in ('queued', 'generating', 'suspended') and chunk_row.status in ('queued', 'processing', 'failed', 'paused') and ((operation_row.scope = 'batch' and plan_row.batch_id = operation_row.target_id) or (operation_row.scope <> 'batch' and chunk_row.profile_id = any(target_profile_ids)));
  cancellation_result := cancellation_result || jsonb_build_object('operationId', operation_row.id, 'compactChunksCancelled', compact_chunks_cancelled, 'compactProfilesCancelled', compact_profiles_cancelled, 'compactHorizonsReleased', compact_horizons_released, 'compactPlansCancelled', compact_plans_cancelled, 'remainingCompactSources', compact_remaining_sources, 'verified', coalesce((cancellation_result ->> 'verified')::boolean, false) and compact_remaining_sources = 0);
  if coalesce((cancellation_result ->> 'verified')::boolean, false) = false or compact_remaining_sources <> 0 then raise exception using errcode = 'P0001', message = 'A verificação final não confirmou o cancelamento completo.'; end if;
  update public.publication_queue_cancellation_operations set status = 'completed', progress = 100, result = cancellation_result, completed_at = timezone('utc', now()) where id = operation_row.id;
  return cancellation_result;
end;
$$;

revoke all on function public.execute_publication_queue_cancellation(uuid) from public, anon, authenticated;
grant execute on function public.execute_publication_queue_cancellation(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Executor: uma chamada = uma etapa; `busy` em vez de esperar; fontes
--    primeiro; item em voo não bloqueia; prazo de 30 minutos
-- ---------------------------------------------------------------------------

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
  sources_result jsonb;
  final_result jsonb;
  affected_batch_id uuid;
  target_organization_id uuid;
  target_profile_ids uuid[];
  cancelable_count integer := 0;
  in_flight_count integer := 0;
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
    count(*) filter (where item_source.status in ('waiting', 'ready', 'failed', 'suspended'))::integer,
    count(*) filter (where item_source.status in ('preparing', 'publishing'))::integer
  into cancelable_count, in_flight_count
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
  if cancelable_count > 1500 or (cancelable_count > 0 and in_flight_count > 0) then
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
$$;

revoke all on function public.execute_server_publication_queue_cancellation(uuid) from public, anon, authenticated;
grant execute on function public.execute_server_publication_queue_cancellation(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 8. Resumo materializado: tom `cancelled` e linha visível pela janela do
--    histórico. Igual à 418 até o select final de `agrupadas`.
-- ---------------------------------------------------------------------------

create or replace function public.refresh_publication_queue_summary(
  p_organization_id uuid,
  p_history_hours integer default 24
)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '120s'
as $$
declare
  started_at timestamptz := clock_timestamp();
  history_hours integer := least(greatest(coalesce(p_history_hours, 24), 1), 168);
  cutoff timestamptz;
  written integer := 0;
  elapsed integer;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not public.is_organization_member(p_organization_id) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  cutoff := timezone('utc', now()) - make_interval(hours => history_hours);

  create temporary table operational_snapshot on commit drop as
  select
    item.profile_id,
    item.batch_id,
    item.status,
    item.execute_at,
    item.archived_at,
    item.lease_until,
    case
      when item.status = 'failed' then exists (
        select 1
        from public.publication_failure_acknowledgements acknowledgement
        where acknowledgement.publication_item_id = item.id
      )
      else false
    end as failure_acknowledged
  from public.publication_items item
  where item.organization_id = p_organization_id
    and (
      item.archived_at is null
      or (item.status = 'published' and item.published_at >= cutoff)
    );

  analyze operational_snapshot;

  insert into public.publication_queue_summary_totals as target (
    organization_id, history_hours, total, historical_total, ok, pending, processing,
    errors, acknowledged_errors, suspended, active, closed, pending_archive,
    expired_leases, active_accounts, suspended_accounts, total_accounts,
    computed_at, duration_ms
  )
  select
    p_organization_id,
    history_hours,
    coalesce(sum(per.total), 0)::integer,
    coalesce(sum(per.historical_total), 0)::integer,
    coalesce(sum(per.ok), 0)::integer,
    coalesce(sum(per.pending), 0)::integer,
    coalesce(sum(per.processing), 0)::integer,
    coalesce(sum(per.errors), 0)::integer,
    coalesce(sum(per.acknowledged_errors), 0)::integer,
    coalesce(sum(per.suspended), 0)::integer,
    coalesce(sum(per.active), 0)::integer,
    coalesce(sum(per.closed), 0)::integer,
    coalesce(sum(per.pending_archive), 0)::integer,
    coalesce(sum(per.expired_leases), 0)::integer,
    count(*) filter (where per.active_for_accounts > 0)::integer,
    count(*) filter (where per.suspended > 0)::integer,
    count(*) filter (where per.total > 0)::integer,
    timezone('utc', now()),
    0
  from (
    select
      profile_id,
      count(*) filter (where status not in ('cancelled', 'removed', 'ignored')) as total,
      count(*) as historical_total,
      count(*) filter (where status = 'published') as ok,
      count(*) filter (where status in ('waiting', 'ready')) as pending,
      count(*) filter (where status in ('preparing', 'publishing')) as processing,
      count(*) filter (where status = 'failed' and not failure_acknowledged) as errors,
      count(*) filter (where status = 'failed' and failure_acknowledged) as acknowledged_errors,
      count(*) filter (where status = 'suspended') as suspended,
      count(*) filter (where status in ('waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended')) as active,
      count(*) filter (where status in ('waiting', 'ready', 'preparing', 'publishing', 'failed')) as active_for_accounts,
      count(*) filter (where status in ('cancelled', 'removed', 'ignored')) as closed,
      count(*) filter (
        where archived_at is null
          and status in ('published', 'cancelled', 'removed', 'ignored')
      ) as pending_archive,
      count(*) filter (
        where status in ('preparing', 'publishing')
          and lease_until is not null
          and lease_until <= timezone('utc', now())
      ) as expired_leases
    from operational_snapshot
    group by profile_id
  ) as per
  on conflict (organization_id) do update set
    history_hours = excluded.history_hours,
    total = excluded.total,
    historical_total = excluded.historical_total,
    ok = excluded.ok,
    pending = excluded.pending,
    processing = excluded.processing,
    errors = excluded.errors,
    acknowledged_errors = excluded.acknowledged_errors,
    suspended = excluded.suspended,
    active = excluded.active,
    closed = excluded.closed,
    pending_archive = excluded.pending_archive,
    expired_leases = excluded.expired_leases,
    active_accounts = excluded.active_accounts,
    suspended_accounts = excluded.suspended_accounts,
    total_accounts = excluded.total_accounts,
    computed_at = excluded.computed_at;

  delete from public.publication_queue_summary_rows where organization_id = p_organization_id;

  insert into public.publication_queue_summary_rows (
    organization_id, scope, row_id, title, username, display_name, profile_picture_url,
    profile_count, created_at, total, historical_total, completed, errors, suspended,
    pending, processing, active, closed, next_at, tone, computed_at
  )
  with agrupadas as (
    select
      'account'::text as scope,
      item.profile_id::text as row_id,
      null::text as title,
      profile.username::text as username,
      profile.display_name::text as display_name,
      profile.profile_picture_url::text as profile_picture_url,
      null::integer as profile_count,
      null::timestamptz as created_at,
      count(*) filter (where item.status not in ('cancelled', 'removed', 'ignored'))::integer as total,
      count(*)::integer as historical_total,
      count(*) filter (where item.status = 'published')::integer as completed,
      count(*) filter (where item.status = 'failed' and not item.failure_acknowledged)::integer as errors,
      count(*) filter (where item.status = 'suspended')::integer as suspended,
      count(*) filter (where item.status in ('waiting', 'ready'))::integer as pending,
      count(*) filter (where item.status in ('preparing', 'publishing'))::integer as processing,
      count(*) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended'))::integer as active,
      count(*) filter (where item.status in ('cancelled', 'removed', 'ignored'))::integer as closed,
      min(item.execute_at) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing')) as next_at,
      case
        when bool_or(item.status in ('preparing', 'publishing')) then 'posting'
        when bool_or(item.status = 'failed' and not item.failure_acknowledged) then 'error'
        when bool_or(item.status in ('waiting', 'ready')) then 'idle'
        when bool_or(item.status = 'suspended') then 'suspended'
        else 'done'
      end::text as tone
    from operational_snapshot item
    join public.instagram_profiles profile on profile.id = item.profile_id
    group by item.profile_id, profile.username, profile.display_name, profile.profile_picture_url

    union all

    select
      'batch',
      item.batch_id::text,
      coalesce(batch.name, 'Sem campanha')::text,
      null, null, null, null,
      batch.created_at,
      count(*) filter (where item.status not in ('cancelled', 'removed', 'ignored'))::integer,
      count(*)::integer,
      count(*) filter (where item.status = 'published')::integer,
      count(*) filter (where item.status = 'failed' and not item.failure_acknowledged)::integer,
      count(*) filter (where item.status = 'suspended')::integer,
      count(*) filter (where item.status in ('waiting', 'ready'))::integer,
      count(*) filter (where item.status in ('preparing', 'publishing'))::integer,
      count(*) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended'))::integer,
      count(*) filter (where item.status in ('cancelled', 'removed', 'ignored'))::integer,
      min(item.execute_at) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing')),
      case
        when bool_or(item.status in ('preparing', 'publishing')) then 'posting'
        when bool_or(item.status = 'failed' and not item.failure_acknowledged) then 'error'
        when bool_or(item.status in ('waiting', 'ready')) then 'idle'
        when bool_or(item.status = 'suspended') then 'suspended'
        else 'done'
      end::text
    from operational_snapshot item
    join public.publication_batches batch on batch.id = item.batch_id
    group by item.batch_id, batch.name, batch.created_at

    union all

    select
      'group',
      coalesce(membership.group_id::text, 'none'),
      coalesce(profile_group.name, 'Sem grupo')::text,
      null, null, null,
      count(distinct item.profile_id)::integer,
      null::timestamptz,
      count(*) filter (where item.status not in ('cancelled', 'removed', 'ignored'))::integer,
      count(*)::integer,
      count(*) filter (where item.status = 'published')::integer,
      count(*) filter (where item.status = 'failed' and not item.failure_acknowledged)::integer,
      count(*) filter (where item.status = 'suspended')::integer,
      count(*) filter (where item.status in ('waiting', 'ready'))::integer,
      count(*) filter (where item.status in ('preparing', 'publishing'))::integer,
      count(*) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended'))::integer,
      count(*) filter (where item.status in ('cancelled', 'removed', 'ignored'))::integer,
      min(item.execute_at) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing')),
      case
        when bool_or(item.status in ('preparing', 'publishing')) then 'posting'
        when bool_or(item.status = 'failed' and not item.failure_acknowledged) then 'error'
        when bool_or(item.status in ('waiting', 'ready')) then 'idle'
        when bool_or(item.status = 'suspended') then 'suspended'
        else 'done'
      end::text
    from operational_snapshot item
    left join (
      select member.profile_id, member.group_id
      from public.profile_group_members member
      where member.organization_id = p_organization_id
    ) membership on membership.profile_id = item.profile_id
    left join public.profile_groups profile_group on profile_group.id = membership.group_id
    group by membership.group_id, profile_group.name
  ),
  -- Cancelamento em massa concluído dentro da janela do histórico, o mais
  -- recente por alvo. Tabela pequena (cresce com cliques, não com a fila).
  recentes as (
    select distinct on (operation.scope, operation.target_id)
      operation.scope,
      operation.target_id::text as row_id,
      operation.target_label,
      operation.completed_at
    from public.publication_queue_cancellation_operations operation
    where operation.organization_id = p_organization_id
      and operation.status = 'completed'
      and operation.completed_at >= cutoff
    order by operation.scope, operation.target_id, operation.completed_at desc
  )
  select
    p_organization_id, a.scope, a.row_id, a.title, a.username, a.display_name, a.profile_picture_url,
    a.profile_count, a.created_at, a.total, a.historical_total, a.completed, a.errors, a.suspended,
    a.pending, a.processing, a.active, a.closed, a.next_at,
    -- "Cancelada": nada ativo E (o alvo teve cancelamento em massa concluído na
    -- janela, OU só tem encerradas e nenhuma publicada). A segunda metade evita
    -- rotular como cancelado um grupo com 50 publicadas e 3 canceladas à mão.
    case
      when a.active = 0 and (r.row_id is not null or (a.closed > 0 and a.completed = 0)) then 'cancelled'
      else a.tone
    end,
    timezone('utc', now())
  from agrupadas a
  left join recentes r on r.scope = a.scope and r.row_id = a.row_id
  -- Agrupamento sem item ativo nem histórico não aparece na tela — exceto o que
  -- acabou de ser cancelado em massa, que fica visível pela janela do histórico.
  where a.total > 0 or r.row_id is not null

  union all

  -- Alvo cancelado cujos itens já foram todos arquivados (a manutenção arquiva
  -- encerrados em minutos) e que não publicou nada na janela: não há mais linha
  -- para agregar, então a linha vem da própria operação, zerada.
  select
    p_organization_id, r.scope, r.row_id,
    case when r.scope = 'account' then null else coalesce(r.target_label, 'Sem nome') end,
    case when r.scope = 'account' then ltrim(coalesce(r.target_label, 'perfil'), '@') else null end,
    null, null, null, null::timestamptz,
    0, 0, 0, 0, 0, 0, 0, 0, 0, null::timestamptz,
    'cancelled',
    timezone('utc', now())
  from recentes r
  where not exists (
    select 1 from agrupadas a where a.scope = r.scope and a.row_id = r.row_id
  );

  get diagnostics written = row_count;
  elapsed := greatest(0, extract(milliseconds from clock_timestamp() - started_at)::integer);
  update public.publication_queue_summary_totals
    set duration_ms = elapsed
    where organization_id = p_organization_id;

  return jsonb_build_object(
    'organizationId', p_organization_id,
    'historyHours', history_hours,
    'rows', written,
    'durationMs', elapsed
  );
end;
$$;

revoke all on function public.refresh_publication_queue_summary(uuid, integer) from public, anon;
grant execute on function public.refresh_publication_queue_summary(uuid, integer) to authenticated, service_role;

notify pgrst, 'reload schema';
