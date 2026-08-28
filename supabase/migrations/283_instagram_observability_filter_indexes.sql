create index if not exists instagram_observability_events_connection_time_idx
  on public.instagram_observability_events (organization_id, connection_id, occurred_at desc, id desc)
  where connection_id is not null;

create index if not exists instagram_observability_events_batch_time_idx
  on public.instagram_observability_events (organization_id, batch_id, occurred_at desc, id desc)
  where batch_id is not null;

create index if not exists instagram_observability_events_job_time_idx
  on public.instagram_observability_events (organization_id, job_id, occurred_at desc, id desc)
  where job_id is not null;

create index if not exists instagram_observability_events_worker_time_idx
  on public.instagram_observability_events (organization_id, worker_kind, occurred_at desc, id desc)
  where worker_kind is not null;

create index if not exists instagram_observability_events_source_status_time_idx
  on public.instagram_observability_events (organization_id, source_status, occurred_at desc, id desc)
  where source_status is not null;

notify pgrst, 'reload schema';
