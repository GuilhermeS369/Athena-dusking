-- Executor exclusivo do servidor. A rota valida sessão, papel, organização e
-- propriedade da operação antes de chamar esta função com service_role.

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
  active_item_ids uuid[] := '{}'::uuid[];
  cancelled_items integer := 0;
  result jsonb;
begin
  select * into operation_row
  from public.publication_queue_cancellation_operations
  where id = p_operation_id
  for update;

  if operation_row.id is null then
    raise exception using errcode = 'P0002', message = 'Operação de cancelamento não encontrada.';
  end if;
  if operation_row.status <> 'running' then
    return operation_row.result || jsonb_build_object('operationId', operation_row.id, 'operationStatus', operation_row.status);
  end if;

  update public.publication_queue_cancellation_operations
  set progress = 20, result = jsonb_build_object('state', 'running', 'operationId', operation_row.id)
  where id = operation_row.id;

  perform 1
  from public.publication_items item_source
  where item_source.organization_id = operation_row.organization_id
    and ((operation_row.scope = 'batch' and item_source.batch_id = operation_row.target_id)
      or (operation_row.scope = 'account' and item_source.profile_id = operation_row.target_id)
      or (operation_row.scope = 'group' and exists (
        select 1 from public.profile_group_members member
        where member.group_id = operation_row.target_id
          and member.organization_id = operation_row.organization_id
          and member.profile_id = item_source.profile_id
      )))
    and item_source.status in ('preparing', 'publishing')
  for update;

  select coalesce(array_agg(item_source.id order by item_source.created_at, item_source.id), '{}'::uuid[])
  into active_item_ids
  from public.publication_items item_source
  where item_source.organization_id = operation_row.organization_id
    and ((operation_row.scope = 'batch' and item_source.batch_id = operation_row.target_id)
      or (operation_row.scope = 'account' and item_source.profile_id = operation_row.target_id)
      or (operation_row.scope = 'group' and exists (
        select 1 from public.profile_group_members member
        where member.group_id = operation_row.target_id
          and member.organization_id = operation_row.organization_id
          and member.profile_id = item_source.profile_id
      )))
    and item_source.status in ('preparing', 'publishing');

  if coalesce(array_length(active_item_ids, 1), 0) > 0 then
    result := jsonb_build_object('state', 'blocked', 'operationId', operation_row.id, 'blockedItemIds', to_jsonb(active_item_ids), 'blockedItems', array_length(active_item_ids, 1), 'message', 'Há publicação(ões) já em processamento. Nenhum item foi cancelado.');
    update public.publication_queue_cancellation_operations
    set status = 'blocked', progress = 100, result = result, completed_at = timezone('utc', now())
    where id = operation_row.id;
    return result;
  end if;

  update public.publication_items item_source
  set status = 'cancelled', cancelled_at = coalesce(item_source.cancelled_at, timezone('utc', now()))
  where item_source.organization_id = operation_row.organization_id
    and ((operation_row.scope = 'batch' and item_source.batch_id = operation_row.target_id)
      or (operation_row.scope = 'account' and item_source.profile_id = operation_row.target_id)
      or (operation_row.scope = 'group' and exists (
        select 1 from public.profile_group_members member
        where member.group_id = operation_row.target_id
          and member.organization_id = operation_row.organization_id
          and member.profile_id = item_source.profile_id
      )))
    and item_source.status in ('waiting', 'ready', 'failed', 'suspended');
  get diagnostics cancelled_items = row_count;

  if operation_row.scope = 'batch' then
    update public.publication_batches
    set status = 'cancelled'
    where id = operation_row.target_id and organization_id = operation_row.organization_id;
  end if;

  result := jsonb_build_object('state', 'cancelled', 'operationId', operation_row.id, 'scope', operation_row.scope, 'cancelledItems', cancelled_items, 'remainingActiveItems', 0, 'verified', true, 'cancelledGenerationJobs', 0, 'excludedGenerationJobs', 0, 'remainingCompactSources', 0);
  update public.publication_queue_cancellation_operations
  set status = 'completed', progress = 100, result = result, completed_at = timezone('utc', now())
  where id = operation_row.id;
  return result;
end;
$$;

revoke all on function public.execute_server_publication_queue_cancellation(uuid) from public, anon, authenticated;
grant execute on function public.execute_server_publication_queue_cancellation(uuid) to service_role;
notify pgrst, 'reload schema';
