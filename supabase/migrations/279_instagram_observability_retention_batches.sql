-- Retenção incremental das fontes legadas durante a transição. Lotes pequenos
-- evitam locks longos enquanto o novo armazenamento particionado assume a carga.

create or replace function public.maintain_instagram_legacy_log_retention_batch(
  p_retention_days integer default 14,
  p_batch_size integer default 5000
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  cutoff timestamptz := timezone('utc', now()) - make_interval(days => greatest(14, least(coalesce(p_retention_days, 14), 14)));
  batch_size integer := greatest(100, least(coalesce(p_batch_size, 5000), 10000));
  publication_events bigint := 0;
  worker_cycles bigint := 0;
  sync_logs bigint := 0;
  anomalies bigint := 0;
  request_rollups bigint := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Apenas service_role mantém os logs legados.';
  end if;
  with expired as (select ctid from public.publication_item_events where created_at < cutoff order by created_at limit batch_size)
  delete from public.publication_item_events target using expired where target.ctid = expired.ctid;
  get diagnostics publication_events = row_count;
  with expired as (select ctid from public.publication_worker_cycle_events where created_at < cutoff order by created_at limit batch_size)
  delete from public.publication_worker_cycle_events target using expired where target.ctid = expired.ctid;
  get diagnostics worker_cycles = row_count;
  with expired as (select ctid from public.zernio_sync_log_items where created_at < cutoff order by created_at limit batch_size)
  delete from public.zernio_sync_log_items target using expired where target.ctid = expired.ctid;
  get diagnostics sync_logs = row_count;
  with expired as (select ctid from public.zernio_publication_request_anomalies where occurred_at < cutoff order by occurred_at limit batch_size)
  delete from public.zernio_publication_request_anomalies target using expired where target.ctid = expired.ctid;
  get diagnostics anomalies = row_count;
  with expired as (select ctid from public.zernio_publication_request_rollups where window_started_at < cutoff order by window_started_at limit batch_size)
  delete from public.zernio_publication_request_rollups target using expired where target.ctid = expired.ctid;
  get diagnostics request_rollups = row_count;
  return jsonb_build_object('cutoff', cutoff, 'publicationEvents', publication_events,
    'workerCycles', worker_cycles, 'syncLogs', sync_logs, 'requestAnomalies', anomalies,
    'requestRollups', request_rollups, 'hasMore', greatest(publication_events, worker_cycles, sync_logs, anomalies, request_rollups) >= batch_size);
end;
$$;

revoke all on function public.maintain_instagram_legacy_log_retention_batch(integer, integer) from public, anon, authenticated;
grant execute on function public.maintain_instagram_legacy_log_retention_batch(integer, integer) to service_role;

