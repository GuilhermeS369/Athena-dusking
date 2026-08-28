-- Permite encerrar, em páginas curtas e auditáveis, publicações vencidas que
-- ainda não chegaram ao provedor. Itens com creation_id nunca entram: eles
-- precisam ser reconciliados para evitar duplicidade ou estado falso.

create or replace function public.ignore_overdue_unstarted_publications(
  p_before timestamptz,
  p_limit integer default 50,
  p_reason text default 'operator_overdue_backlog_cleanup'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  item_row public.publication_items%rowtype;
  affected integer := 0;
  affected_ids uuid[] := '{}'::uuid[];
  affected_batch_ids uuid[] := '{}'::uuid[];
  batch_id_value uuid;
  decided_at timestamptz := timezone('utc', now());
  reason_value text := left(coalesce(nullif(trim(p_reason), ''), 'operator_overdue_backlog_cleanup'), 120);
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Somente service_role pode encerrar backlog vencido.';
  end if;
  if p_before is null or p_before > decided_at or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Corte ou limite inválido.';
  end if;

  for item_row in
    select item.*
    from public.publication_items item
    where item.archived_at is null
      and item.pipeline_version = 2
      and item.status in ('waiting', 'ready')
      and item.execute_at is not null
      and item.execute_at < p_before
      and item.creation_id is null
      and (item.lease_until is null or item.lease_until <= decided_at)
    order by item.execute_at, item.organization_id, item.profile_id, item.id
    for update skip locked
    limit p_limit
  loop
    update public.publication_items item
    set status = 'ignored',
        claimed_by = null,
        lease_until = null,
        next_attempt_at = null,
        last_error_code = reason_value,
        last_error_message = 'O horário passou durante a contenção de carga; a postagem não será enviada atrasada.'
    where item.id = item_row.id
      and item.status in ('waiting', 'ready')
      and item.creation_id is null;

    if found then
      delete from public.publication_profile_daily_reservations
      where publication_item_id = item_row.id;
      delete from public.publication_dispatch_rate_reservations
      where publication_item_id = item_row.id;

      perform public.log_publication_item_event(
        item_row.id,
        'ignored',
        item_row.status,
        'ignored',
        null,
        'system: operator-overdue-cleanup',
        reason_value,
        'O horário passou durante a contenção de carga; a postagem não será enviada atrasada.',
        jsonb_build_object(
          'execute_at', item_row.execute_at,
          'cutoff_at', p_before,
          'decided_at', decided_at,
          'provider_creation_absent', true
        )
      );

      affected := affected + 1;
      affected_ids := array_append(affected_ids, item_row.id);
      if not item_row.batch_id = any(affected_batch_ids) then
        affected_batch_ids := array_append(affected_batch_ids, item_row.batch_id);
      end if;
    end if;
  end loop;

  foreach batch_id_value in array affected_batch_ids loop
    perform public.sync_publication_batch_status(batch_id_value);
  end loop;

  return jsonb_build_object(
    'ignored', affected,
    'itemIds', affected_ids,
    'batchIds', affected_batch_ids,
    'cutoffAt', p_before,
    'decidedAt', decided_at
  );
end;
$$;

revoke all on function public.ignore_overdue_unstarted_publications(timestamptz, integer, text)
  from public, anon, authenticated;
grant execute on function public.ignore_overdue_unstarted_publications(timestamptz, integer, text)
  to service_role;

notify pgrst, 'reload schema';
