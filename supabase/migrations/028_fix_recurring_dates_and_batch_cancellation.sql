-- A data calculada pelo compositor para cada ocorrência recorrente é a fonte
-- de verdade. A função abaixo continua aceitando scheduleTime por compatibilidade
-- com itens legados, mas executeAt não pode ser descartado ou reinterpretado.
create or replace function public.cancel_publication_batch_items(
  p_batch_id uuid,
  p_item_ids uuid[] default null,
  p_scope text default 'entire_batch'
)
returns table (
  cancelled_item_id uuid,
  previous_status public.publication_item_status
)
language plpgsql
security definer
set search_path = public
as $$
declare
  batch_organization_id uuid;
  item_row public.publication_items%rowtype;
begin
  if p_scope not in ('entire_batch', 'visible_items') then
    raise exception using errcode = '22023', message = 'Escopo de cancelamento inválido';
  end if;

  select organization_id into batch_organization_id
  from public.publication_batches
  where id = p_batch_id
  for update;

  if batch_organization_id is null then
    raise exception using errcode = 'P0002', message = 'Lote de publicação não encontrado';
  end if;
  if not public.has_organization_role(batch_organization_id, array['admin', 'operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;
  if p_scope = 'visible_items' and coalesce(array_length(p_item_ids, 1), 0) = 0 then
    raise exception using errcode = '22023', message = 'Informe os itens exibidos para cancelar';
  end if;

  for item_row in
    select *
    from public.publication_items
    where batch_id = p_batch_id
      and (p_scope = 'entire_batch' or id = any(p_item_ids))
      and status in ('waiting', 'ready', 'preparing', 'publishing', 'failed')
    for update
  loop
    update public.publication_items
    set status = 'cancelled',
        cancelled_at = timezone('utc', now()),
        next_attempt_at = null,
        lease_until = null,
        claimed_by = null,
        creation_id = null
    where id = item_row.id;

    perform public.log_publication_item_event(
      item_row.id,
      'cancelled',
      item_row.status,
      'cancelled',
      auth.uid(),
      auth.jwt() ->> 'email',
      null,
      null,
      jsonb_build_object('action', case when p_scope = 'entire_batch' then 'cancelled_batch_by_user' else 'cancelled_filtered_batch_items_by_user' end, 'batch_id', p_batch_id)
    );

    cancelled_item_id := item_row.id;
    previous_status := item_row.status;
    return next;
  end loop;

  perform public.sync_publication_batch_status(p_batch_id);
end;
$$;

revoke all on function public.cancel_publication_batch_items(uuid, uuid[], text) from public, anon;
grant execute on function public.cancel_publication_batch_items(uuid, uuid[], text) to authenticated;
