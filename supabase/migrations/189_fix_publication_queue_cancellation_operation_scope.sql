-- Evita ambiguidade entre a coluna de tabela e a variável local usada pela
-- rotina durável. Sem isso, a execução parava antes de atualizar o progresso.

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
  select * into operation_row
  from public.publication_queue_cancellation_operations
  where id = p_operation_id
  for update;

  if operation_row.id is null then
    raise exception using errcode = 'P0002', message = 'Operação de cancelamento não encontrada.';
  end if;
  if auth.uid() is null or operation_row.requested_by <> auth.uid() then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;
  if operation_row.status <> 'running' then
    return operation_row.result || jsonb_build_object('operationId', operation_row.id, 'operationStatus', operation_row.status);
  end if;

  operation_organization_id := operation_row.organization_id;
  if not public.has_organization_role(operation_organization_id, array['admin', 'operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  if operation_row.scope = 'batch' then
    perform 1 from public.publication_batches batch_row
    where batch_row.id = operation_row.target_id and batch_row.organization_id = operation_organization_id
    for update;
    if not found then raise exception using errcode = 'P0002', message = 'Lote de publicação não encontrado.'; end if;
  elsif operation_row.scope = 'account' then
    select array[profile_row.id] into target_profile_ids
    from public.instagram_profiles profile_row
    where profile_row.id = operation_row.target_id and profile_row.organization_id = operation_organization_id and profile_row.deleted_at is null
    for update;
    if target_profile_ids is null then raise exception using errcode = 'P0002', message = 'Perfil não encontrado.'; end if;
  else
    perform 1 from public.profile_groups group_row
    where group_row.id = operation_row.target_id and group_row.organization_id = operation_organization_id and group_row.deleted_at is null
    for update;
    if not found then raise exception using errcode = 'P0002', message = 'Grupo não encontrado.'; end if;
    select coalesce(array_agg(member.profile_id order by member.profile_id), '{}'::uuid[]) into target_profile_ids
    from public.profile_group_members member
    where member.organization_id = operation_organization_id and member.group_id = operation_row.target_id;
  end if;

  update public.publication_queue_cancellation_operations
  set progress = 20, result = jsonb_build_object('state', 'running', 'operationId', operation_row.id)
  where id = operation_row.id;

  perform 1 from public.bulk_publication_generation_chunks chunk_row
  join public.bulk_publication_plans plan_row on plan_row.id = chunk_row.plan_id
  where plan_row.organization_id = operation_organization_id
    and ((operation_row.scope = 'batch' and plan_row.batch_id = operation_row.target_id) or (operation_row.scope <> 'batch' and chunk_row.profile_id = any(target_profile_ids)))
  order by chunk_row.created_at, chunk_row.id for update of chunk_row;

  perform 1 from public.bulk_publication_plan_profiles plan_profile
  join public.bulk_publication_plans plan_row on plan_row.id = plan_profile.plan_id
  where plan_row.organization_id = operation_organization_id
    and ((operation_row.scope = 'batch' and plan_row.batch_id = operation_row.target_id) or (operation_row.scope <> 'batch' and plan_profile.profile_id = any(target_profile_ids)))
  order by plan_profile.created_at, plan_profile.id for update of plan_profile;

  for item_row in
    select item_source.* from public.publication_items item_source
    where item_source.organization_id = operation_organization_id
      and ((operation_row.scope = 'batch' and item_source.batch_id = operation_row.target_id) or (operation_row.scope <> 'batch' and item_source.profile_id = any(target_profile_ids)))
      and item_source.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended')
    order by item_source.created_at, item_source.id for update
  loop
    if item_row.status in ('preparing', 'publishing') then blocked_item_ids := array_append(blocked_item_ids, item_row.id); end if;
  end loop;

  if coalesce(array_length(blocked_item_ids, 1), 0) > 0 then
    cancellation_result := jsonb_build_object('state', 'blocked', 'operationId', operation_row.id, 'blockedItemIds', to_jsonb(blocked_item_ids), 'blockedItems', coalesce(array_length(blocked_item_ids, 1), 0), 'message', 'Há publicação(ões) já em processamento. Nenhum item foi cancelado.');
    update public.publication_queue_cancellation_operations set status = 'blocked', progress = 100, result = cancellation_result, completed_at = timezone('utc', now()) where id = operation_row.id;
    return cancellation_result;
  end if;

  update public.bulk_publication_generation_chunks chunk_row
  set status = 'cancelled', claimed_by = null, lease_until = null, completed_at = coalesce(chunk_row.completed_at, timezone('utc', now())), last_error_message = 'Cancelado pela fila operacional.'
  from public.bulk_publication_plans plan_row
  where plan_row.id = chunk_row.plan_id and plan_row.organization_id = operation_organization_id
    and ((operation_row.scope = 'batch' and plan_row.batch_id = operation_row.target_id) or (operation_row.scope <> 'batch' and chunk_row.profile_id = any(target_profile_ids)))
    and chunk_row.status in ('queued', 'processing', 'failed', 'paused');
  get diagnostics compact_chunks_cancelled = row_count;

  update public.bulk_publication_plan_profiles plan_profile
  set status = 'cancelled', suspended_at = coalesce(plan_profile.suspended_at, timezone('utc', now())), suspension_reason = 'Cancelado pela fila operacional.'
  from public.bulk_publication_plans plan_row
  where plan_row.id = plan_profile.plan_id and plan_row.organization_id = operation_organization_id
    and ((operation_row.scope = 'batch' and plan_row.batch_id = operation_row.target_id) or (operation_row.scope <> 'batch' and plan_profile.profile_id = any(target_profile_ids)))
    and plan_profile.status in ('queued', 'generating', 'suspended', 'failed');
  get diagnostics compact_profiles_cancelled = row_count;

  update public.bulk_publication_profile_horizons horizon
  set status = 'cancelled', released_at = coalesce(horizon.released_at, timezone('utc', now()))
  from public.bulk_publication_plans plan_row
  where plan_row.id = horizon.plan_id and plan_row.organization_id = operation_organization_id
    and ((operation_row.scope = 'batch' and plan_row.batch_id = operation_row.target_id) or (operation_row.scope <> 'batch' and horizon.profile_id = any(target_profile_ids)))
    and horizon.status = 'active';
  get diagnostics compact_horizons_released = row_count;

  for compact_plan_id in
    select distinct plan_row.id from public.bulk_publication_plans plan_row
    where plan_row.organization_id = operation_organization_id
      and ((operation_row.scope = 'batch' and plan_row.batch_id = operation_row.target_id) or (operation_row.scope <> 'batch' and exists (select 1 from public.bulk_publication_plan_profiles profile_plan where profile_plan.plan_id = plan_row.id and profile_plan.profile_id = any(target_profile_ids))))
  loop
    if not exists (select 1 from public.bulk_publication_plan_profiles profile_plan where profile_plan.plan_id = compact_plan_id and profile_plan.status <> 'cancelled') then
      update public.bulk_publication_plans set status = 'cancelled', completed_at = timezone('utc', now()), metadata = metadata || jsonb_build_object('cancelled_at', timezone('utc', now()), 'cancelled_by', auth.uid()) where id = compact_plan_id and status <> 'cancelled';
      if found then compact_plans_cancelled := compact_plans_cancelled + 1; end if;
    else
      perform public.refresh_bulk_rotation_plan_state(compact_plan_id);
    end if;
  end loop;

  update public.publication_queue_cancellation_operations set progress = 65 where id = operation_row.id;
  cancellation_result := public.cancel_publication_queue_scope(operation_row.scope, operation_row.target_id);
  if cancellation_result ->> 'state' = 'blocked' then
    update public.publication_queue_cancellation_operations set status = 'blocked', progress = 100, result = cancellation_result || jsonb_build_object('operationId', operation_row.id), completed_at = timezone('utc', now()) where id = operation_row.id;
    return cancellation_result || jsonb_build_object('operationId', operation_row.id);
  end if;

  select count(*)::integer into compact_remaining_sources
  from public.bulk_publication_generation_chunks chunk_row
  join public.bulk_publication_plans plan_row on plan_row.id = chunk_row.plan_id
  join public.bulk_publication_plan_profiles profile_plan on profile_plan.id = chunk_row.plan_profile_id
  where plan_row.organization_id = operation_organization_id
    and plan_row.status in ('queued', 'generating', 'paused') and profile_plan.status in ('queued', 'generating', 'suspended') and chunk_row.status in ('queued', 'processing', 'failed', 'paused')
    and ((operation_row.scope = 'batch' and plan_row.batch_id = operation_row.target_id) or (operation_row.scope <> 'batch' and chunk_row.profile_id = any(target_profile_ids)));

  cancellation_result := cancellation_result || jsonb_build_object('operationId', operation_row.id, 'compactChunksCancelled', compact_chunks_cancelled, 'compactProfilesCancelled', compact_profiles_cancelled, 'compactHorizonsReleased', compact_horizons_released, 'compactPlansCancelled', compact_plans_cancelled, 'remainingCompactSources', compact_remaining_sources, 'verified', coalesce((cancellation_result ->> 'verified')::boolean, false) and compact_remaining_sources = 0);
  if coalesce((cancellation_result ->> 'verified')::boolean, false) = false or compact_remaining_sources <> 0 then raise exception using errcode = 'P0001', message = 'A verificação final não confirmou o cancelamento completo.'; end if;

  update public.publication_queue_cancellation_operations set status = 'completed', progress = 100, result = cancellation_result, completed_at = timezone('utc', now()) where id = operation_row.id;
  return cancellation_result;
end;
$$;

revoke all on function public.execute_publication_queue_cancellation(uuid) from public, anon, authenticated;
grant execute on function public.execute_publication_queue_cancellation(uuid) to authenticated;
notify pgrst, 'reload schema';
