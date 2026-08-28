-- Encerra resíduos intermediários de um worker interrompido somente quando o
-- provedor nunca recebeu criação e o lease já expirou.

create or replace function public.ignore_expired_unstarted_publication_leases(
  p_before timestamptz,
  p_expected integer,
  p_reason text default 'operator_expired_unstarted_lease_cleanup'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  item_row public.publication_items%rowtype;
  candidate_count integer;
  affected integer := 0;
  affected_batch_ids uuid[] := '{}'::uuid[];
  batch_id_value uuid;
  decided_at timestamptz := timezone('utc', now());
  reason_value text := left(coalesce(nullif(trim(p_reason), ''), 'operator_expired_unstarted_lease_cleanup'), 120);
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Somente service_role pode encerrar leases expirados.';
  end if;
  if p_before is null or p_before > decided_at or p_expected not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Corte ou quantidade esperada inválida.';
  end if;

  select count(*)::integer into candidate_count
  from public.publication_items item
  where item.archived_at is null
    and item.pipeline_version = 2
    and item.status in ('preparing', 'publishing')
    and item.execute_at is not null and item.execute_at < p_before
    and item.creation_id is null
    and item.lease_until is not null and item.lease_until <= decided_at;
  if candidate_count <> p_expected then
    raise exception using errcode = '22023',
      message = format('Resíduos divergentes: esperado %s, encontrado %s.', p_expected, candidate_count);
  end if;

  for item_row in
    select item.*
    from public.publication_items item
    where item.archived_at is null
      and item.pipeline_version = 2
      and item.status in ('preparing', 'publishing')
      and item.execute_at is not null and item.execute_at < p_before
      and item.creation_id is null
      and item.lease_until is not null and item.lease_until <= decided_at
    order by item.execute_at, item.organization_id, item.profile_id, item.id
    for update
  loop
    update public.publication_items item
    set status = 'ignored', claimed_by = null, lease_until = null,
        next_attempt_at = null, last_error_code = reason_value,
        last_error_message = 'O lease expirou sem criação no provedor; a postagem vencida não será enviada.'
    where item.id = item_row.id and item.creation_id is null
      and item.status in ('preparing', 'publishing')
      and item.lease_until <= decided_at;
    if found then
      delete from public.publication_profile_daily_reservations where publication_item_id = item_row.id;
      delete from public.publication_dispatch_rate_reservations where publication_item_id = item_row.id;
      perform public.log_publication_item_event(
        item_row.id, 'ignored', item_row.status, 'ignored', null,
        'system: operator-expired-lease-cleanup', reason_value,
        'O lease expirou sem criação no provedor; a postagem vencida não será enviada.',
        jsonb_build_object('execute_at', item_row.execute_at, 'cutoff_at', p_before,
          'expired_lease_at', item_row.lease_until, 'decided_at', decided_at,
          'provider_creation_absent', true)
      );
      affected := affected + 1;
      if not item_row.batch_id = any(affected_batch_ids) then
        affected_batch_ids := array_append(affected_batch_ids, item_row.batch_id);
      end if;
    end if;
  end loop;

  foreach batch_id_value in array affected_batch_ids loop
    perform public.sync_publication_batch_status(batch_id_value);
  end loop;
  return jsonb_build_object('ignored', affected, 'expected', p_expected,
    'batchIds', affected_batch_ids, 'cutoffAt', p_before, 'decidedAt', decided_at);
end;
$$;

revoke all on function public.ignore_expired_unstarted_publication_leases(timestamptz, integer, text)
  from public, anon, authenticated;
grant execute on function public.ignore_expired_unstarted_publication_leases(timestamptz, integer, text)
  to service_role;

notify pgrst, 'reload schema';
