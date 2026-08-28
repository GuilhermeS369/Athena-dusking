-- Limpeza em blocos evita timeout em filas grandes. O cancelador servidor volta
-- a executar tanto o cancelador tradicional (jobs, reservas e auditoria) quanto
-- o cancelador de planos compactos, na mesma transação verificável.

drop function if exists public.clean_publication_queue_finished(uuid);

create or replace function public.clean_publication_queue_finished(
  p_organization_id uuid,
  p_limit integer default 2000
)
returns table (
  archived_completed_count integer,
  archived_failure_count integer,
  remaining_finished_count bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  resolved_limit integer := least(greatest(coalesce(p_limit, 2000), 1), 5000);
  completed_count integer := 0;
  failure_count integer := 0;
  remaining_count bigint := 0;
begin
  if auth.role() <> 'service_role' and (
    actor_id is null or not public.has_organization_role(
      p_organization_id,
      array['admin', 'operator']::public.organization_role[]
    )
  ) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  with candidates as (
    select item.id
    from public.publication_items item
    where item.organization_id = p_organization_id
      and item.archived_at is null
      and item.status in ('published', 'cancelled', 'removed', 'ignored')
    order by item.created_at, item.id
    limit resolved_limit
    for update skip locked
  ), archived as (
    update public.publication_items item
    set archived_at = timezone('utc', now()), archived_by = actor_id
    from candidates
    where item.id = candidates.id
    returning item.id
  )
  select count(*)::integer into completed_count from archived;

  with candidates as (
    select item.id
    from public.publication_items item
    where item.organization_id = p_organization_id
      and item.archived_at is null
      and item.status = 'failed'
    order by item.created_at, item.id
    limit greatest(resolved_limit - completed_count, 0)
    for update skip locked
  ), archived as (
    update public.publication_items item
    set archived_at = timezone('utc', now()), archived_by = actor_id
    from candidates
    where item.id = candidates.id
    returning item.id
  ), acknowledged as (
    insert into public.publication_failure_acknowledgements (
      publication_item_id, organization_id, acknowledged_by, scope
    )
    select id, p_organization_id, actor_id, 'visible_items'
    from archived
    on conflict (publication_item_id) do nothing
  )
  select count(*)::integer into failure_count from archived;

  insert into public.publication_queue_action_audits (
    organization_id, actor_user_id, action, affected_count, item_ids, metadata
  ) values
    (p_organization_id, actor_id, 'archive_completed', completed_count, '{}'::uuid[],
      jsonb_build_object('scope', 'queue_cleanup', 'bulk', true)),
    (p_organization_id, actor_id, 'acknowledge_failures', failure_count, '{}'::uuid[],
      jsonb_build_object('scope', 'queue_cleanup', 'archived', true, 'bulk', true));

  select count(*) into remaining_count
  from public.publication_items item
  where item.organization_id = p_organization_id
    and item.archived_at is null
    and item.status in ('published', 'cancelled', 'removed', 'ignored', 'failed');

  return query select completed_count, failure_count, remaining_count;
end;
$$;

revoke all on function public.clean_publication_queue_finished(uuid, integer) from public, anon;
grant execute on function public.clean_publication_queue_finished(uuid, integer) to authenticated, service_role;

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

  traditional_result := public.cancel_publication_queue_scope(
    operation_row.scope,
    operation_row.target_id
  );

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

  final_result := compact_result || jsonb_build_object(
    'operationId', operation_row.id,
    'cancelledItems', coalesce((traditional_result ->> 'cancelledItems')::integer, 0),
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

-- Repara estados de lote já contaminados pelo cancelador anterior sem cancelar
-- publicações: o estado volta a ser derivado dos itens que realmente existem.
do $$
declare
  repair_batch_id uuid;
begin
  for repair_batch_id in
    select batch.id
    from public.publication_batches batch
    where batch.status = 'cancelled'
      and exists (
        select 1 from public.publication_items item
        where item.batch_id = batch.id
          and item.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended')
      )
  loop
    perform public.sync_publication_batch_status(repair_batch_id);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
