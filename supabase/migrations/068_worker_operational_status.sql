-- Observabilidade operacional dos workers dedicados.
-- Expõe um resumo sanitizado de heartbeats e backlog para a Central Operacional
-- sem carregar listas grandes de jobs ou filas no servidor Next.js.

create or replace function public.get_worker_operational_status(
  p_organization_id uuid,
  p_stale_after_seconds integer default 120
)
returns table (
  worker_id text,
  worker_kind text,
  status text,
  dry_run boolean,
  version text,
  hostname text,
  process_id integer,
  started_at timestamptz,
  last_seen_at timestamptz,
  seconds_since_seen integer,
  is_stale boolean,
  last_error_message text,
  metadata jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select
    heartbeat.worker_id,
    heartbeat.worker_kind,
    heartbeat.status,
    heartbeat.dry_run,
    heartbeat.version,
    heartbeat.hostname,
    heartbeat.process_id,
    heartbeat.started_at,
    heartbeat.last_seen_at,
    greatest(0, extract(epoch from (timezone('utc', now()) - heartbeat.last_seen_at))::integer) as seconds_since_seen,
    heartbeat.last_seen_at < timezone('utc', now()) - make_interval(secs => greatest(30, least(coalesce(p_stale_after_seconds, 120), 3600))) as is_stale,
    heartbeat.last_error_message,
    heartbeat.metadata
  from public.publication_worker_heartbeats heartbeat
  where public.is_organization_member(p_organization_id)
  order by heartbeat.worker_kind, heartbeat.last_seen_at desc, heartbeat.worker_id;
$$;

create or replace function public.get_async_job_operational_summary(
  p_organization_id uuid
)
returns table (
  job_kind text,
  status text,
  total integer,
  pending_units integer,
  failed_units integer,
  oldest_created_at timestamptz,
  newest_updated_at timestamptz,
  max_age_seconds integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    source.job_kind,
    source.status,
    count(*)::integer as total,
    coalesce(sum(source.pending_units), 0)::integer as pending_units,
    coalesce(sum(source.failed_units), 0)::integer as failed_units,
    min(source.created_at) as oldest_created_at,
    max(source.updated_at) as newest_updated_at,
    coalesce(max(greatest(0, extract(epoch from (timezone('utc', now()) - source.created_at))::integer)), 0)::integer as max_age_seconds
  from (
    select
      'publication_generation'::text as job_kind,
      job.status::text as status,
      greatest(0, coalesce(job.expected_items, 0) - coalesce(job.generated_items, 0) - coalesce(job.failed_items, 0))::integer as pending_units,
      coalesce(job.failed_items, 0)::integer as failed_units,
      job.created_at,
      job.updated_at
    from public.publication_generation_jobs job
    where job.organization_id = p_organization_id
      and job.status in ('queued', 'processing', 'paused', 'failed')

    union all

    select
      'media_deletion'::text as job_kind,
      job.status::text as status,
      greatest(0, coalesce(job.total_count, 0) - coalesce(job.processed_count, 0))::integer as pending_units,
      coalesce(job.failed_count, 0)::integer as failed_units,
      job.created_at,
      job.updated_at
    from public.media_deletion_jobs job
    where job.organization_id = p_organization_id
      and job.status in ('pending', 'processing', 'completed_with_errors', 'failed')

    union all

    select
      'media_group_assignment'::text as job_kind,
      job.status::text as status,
      greatest(0, coalesce(job.total_count, 0) - coalesce(job.processed_count, 0))::integer as pending_units,
      coalesce(job.failed_count, 0)::integer as failed_units,
      job.created_at,
      job.updated_at
    from public.media_group_assignment_jobs job
    where job.organization_id = p_organization_id
      and job.status in ('pending', 'processing', 'completed_with_errors', 'failed')
  ) source
  where public.is_organization_member(p_organization_id)
  group by source.job_kind, source.status
  order by source.job_kind, source.status;
$$;

revoke all on function public.get_worker_operational_status(uuid, integer) from public, anon;
revoke all on function public.get_async_job_operational_summary(uuid) from public, anon;
grant execute on function public.get_worker_operational_status(uuid, integer) to authenticated, service_role;
grant execute on function public.get_async_job_operational_summary(uuid) to authenticated, service_role;
