-- Vários itens podem terminar no mesmo instante. Sem um lock por lote, cada
-- transação ainda enxerga outro item como processing e nenhuma delas encerra o
-- lote, embora todos os itens já estejam completed.

create or replace function public.complete_zernio_sync_batch_item(
  p_item_id uuid,
  p_worker_id text,
  p_synced_count integer default 0,
  p_conflict_count integer default 0,
  p_error_message text default null
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  item_row public.zernio_sync_batch_items%rowtype;
  retry_seconds integer;
  remaining_count integer;
  failed_count integer;
  synced_total integer;
  conflict_total integer;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao worker.';
  end if;
  select * into item_row from public.zernio_sync_batch_items
  where id = p_item_id and claimed_by = trim(p_worker_id) and lease_until > timezone('utc', now()) and status = 'processing'
  for update;
  if not found then raise exception using errcode = 'P0002', message = 'Item não está sob lease deste worker.'; end if;

  if nullif(trim(coalesce(p_error_message, '')), '') is not null and item_row.attempt_count < 3 then
    retry_seconds := least(900, 30 * power(2, item_row.attempt_count - 1)::integer);
    update public.zernio_sync_batch_items
    set status = 'queued'::public.zernio_sync_item_status, claimed_by = null, lease_until = null,
        next_attempt_at = timezone('utc', now()) + make_interval(secs => retry_seconds),
        error_message = left(trim(p_error_message), 1200)
    where id = item_row.id;
    return jsonb_build_object('completed', false, 'retryAtSeconds', retry_seconds);
  end if;

  update public.zernio_sync_batch_items
  set status = case
        when nullif(trim(coalesce(p_error_message, '')), '') is null
          then 'completed'::public.zernio_sync_item_status
        else 'failed'::public.zernio_sync_item_status
      end,
      claimed_by = null, lease_until = null, synced_count = greatest(0, p_synced_count),
      conflict_count = greatest(0, p_conflict_count), error_message = left(nullif(trim(p_error_message), ''), 1200),
      completed_at = timezone('utc', now())
  where id = item_row.id;

  perform pg_advisory_xact_lock(hashtextextended('zernio-sync-batch:' || item_row.batch_id::text, 0));
  select count(*) filter (where status in ('queued', 'processing'))::integer,
         count(*) filter (where status = 'failed')::integer,
         coalesce(sum(synced_count), 0)::integer,
         coalesce(sum(conflict_count), 0)::integer
  into remaining_count, failed_count, synced_total, conflict_total
  from public.zernio_sync_batch_items where batch_id = item_row.batch_id;
  if remaining_count = 0 then
    update public.zernio_sync_batches
    set status = case
          when failed_count > 0 or conflict_total > 0
            then 'completed_with_errors'::public.zernio_sync_batch_status
          else 'completed'::public.zernio_sync_batch_status
        end,
        synced_count = synced_total, conflict_count = conflict_total, failure_count = failed_count,
        completed_at = timezone('utc', now())
    where id = item_row.batch_id;
  end if;
  return jsonb_build_object('completed', true, 'batchId', item_row.batch_id, 'remaining', remaining_count);
end;
$$;

notify pgrst, 'reload schema';
