-- Evita falsos positivos de health causados por IDs dinâmicos de processos PM2
-- antigos. O status operacional passa a considerar apenas o heartbeat mais
-- recente por worker lógico, preservando suporte a IDs estáveis configurados
-- explicitamente via ambiente.

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
  with normalized as (
    select
      heartbeat.*,
      case
        when heartbeat.process_id is not null
          and heartbeat.worker_id ~ ('-' || heartbeat.process_id::text || '$')
        then regexp_replace(heartbeat.worker_id, '-' || heartbeat.process_id::text || '$', '')
        else heartbeat.worker_id
      end as logical_worker_id
    from public.publication_worker_heartbeats heartbeat
  ), ranked as (
    select
      normalized.*,
      row_number() over (
        partition by normalized.worker_kind, coalesce(normalized.hostname, ''), normalized.logical_worker_id
        order by normalized.last_seen_at desc, normalized.started_at desc, normalized.worker_id
      ) as logical_rank
    from normalized
  ), worker_kind_activity as (
    select
      worker.worker_kind,
      count(*) filter (
        where worker.last_seen_at >= timezone('utc', now()) - make_interval(secs => greatest(30, least(coalesce(p_stale_after_seconds, 120), 3600)))
          and worker.status not in ('stopped', 'error')
      ) as active_in_kind
    from ranked worker
    where worker.logical_rank = 1
      and (
        worker.status <> 'stopped'
        or worker.last_seen_at >= timezone('utc', now()) - interval '24 hours'
      )
    group by worker.worker_kind
  )
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
    (
      heartbeat.last_seen_at < timezone('utc', now()) - make_interval(secs => greatest(30, least(coalesce(p_stale_after_seconds, 120), 3600)))
      and coalesce(worker_kind_activity.active_in_kind, 0) = 0
    ) as is_stale,
    heartbeat.last_error_message,
    heartbeat.metadata
  from ranked heartbeat
  left join worker_kind_activity on worker_kind_activity.worker_kind = heartbeat.worker_kind
  where heartbeat.logical_rank = 1
    and (
      heartbeat.status <> 'stopped'
      or heartbeat.last_seen_at >= timezone('utc', now()) - interval '24 hours'
    )
    and public.is_organization_member(p_organization_id)
  order by heartbeat.worker_kind, heartbeat.last_seen_at desc, heartbeat.worker_id;
$$;

create or replace function public.get_global_operational_health(
  p_stale_after_seconds integer default 120,
  p_queue_lag_warning_seconds integer default 300,
  p_async_job_age_warning_seconds integer default 1800
)
returns table (
  health_status text,
  organization_count integer,
  active_publication_items integer,
  expired_leases integer,
  due_retries integer,
  overdue_publications integer,
  max_lag_seconds integer,
  registered_workers integer,
  active_workers integer,
  stale_workers integer,
  worker_errors integer,
  open_async_jobs integer,
  async_pending_units integer,
  async_failed_units integer,
  old_async_jobs integer,
  published_last_hour integer,
  published_last_24h integer,
  failed_last_hour integer,
  critical_signals integer,
  warning_signals integer
)
language sql
stable
security definer
set search_path = public
as $$
  with settings as (
    select
      greatest(30, least(coalesce(p_stale_after_seconds, 120), 3600)) as stale_after_seconds,
      greatest(60, least(coalesce(p_queue_lag_warning_seconds, 300), 86400)) as queue_lag_warning_seconds,
      greatest(300, least(coalesce(p_async_job_age_warning_seconds, 1800), 604800)) as async_job_age_warning_seconds,
      timezone('utc', now()) as now_at
  ), organizations_summary as (
    select count(*)::integer as organization_count
    from public.organizations organization_row
    where organization_row.deleted_at is null
  ), queue_summary as (
    select
      count(*)::integer as active_publication_items,
      count(*) filter (where item.lease_until is not null and item.lease_until <= (select now_at from settings))::integer as expired_leases,
      count(*) filter (where item.status = 'failed' and item.next_attempt_at is not null and item.next_attempt_at <= (select now_at from settings))::integer as due_retries,
      count(*) filter (where item.status in ('waiting', 'ready') and item.execute_at is not null and item.execute_at < (select now_at from settings) - interval '120 seconds')::integer as overdue_publications,
      coalesce(max(greatest(0, extract(epoch from ((select now_at from settings) - item.execute_at))::integer)) filter (
        where item.execute_at is not null
          and item.execute_at < (select now_at from settings)
          and item.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed')
      ), 0)::integer as max_lag_seconds
    from public.publication_items item
    where item.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed')
  ), normalized_workers as (
    select
      heartbeat.*,
      case
        when heartbeat.process_id is not null
          and heartbeat.worker_id ~ ('-' || heartbeat.process_id::text || '$')
        then regexp_replace(heartbeat.worker_id, '-' || heartbeat.process_id::text || '$', '')
        else heartbeat.worker_id
      end as logical_worker_id
    from public.publication_worker_heartbeats heartbeat
  ), ranked_workers as (
    select
      normalized_workers.*,
      row_number() over (
        partition by normalized_workers.worker_kind, coalesce(normalized_workers.hostname, ''), normalized_workers.logical_worker_id
        order by normalized_workers.last_seen_at desc, normalized_workers.started_at desc, normalized_workers.worker_id
      ) as logical_rank
    from normalized_workers
  ), worker_scope as (
    select *
    from ranked_workers worker
    where worker.logical_rank = 1
      and (
        worker.status <> 'stopped'
        or worker.last_seen_at >= (select now_at from settings) - interval '24 hours'
      )
  ), worker_kind_activity as (
    select
      worker.worker_kind,
      count(*) filter (
        where worker.last_seen_at >= (select now_at from settings) - make_interval(secs => (select stale_after_seconds from settings))
          and worker.status not in ('stopped', 'error')
      ) as active_in_kind
    from worker_scope worker
    group by worker.worker_kind
  ), worker_summary as (
    select
      count(*)::integer as registered_workers,
      count(*) filter (
        where heartbeat.last_seen_at >= (select now_at from settings) - make_interval(secs => (select stale_after_seconds from settings))
          and heartbeat.status not in ('stopped', 'error')
      )::integer as active_workers,
      count(*) filter (
        where (
            heartbeat.last_seen_at < (select now_at from settings) - make_interval(secs => (select stale_after_seconds from settings))
            or heartbeat.status = 'stopped'
          )
          and coalesce(worker_kind_activity.active_in_kind, 0) = 0
      )::integer as stale_workers,
      count(*) filter (where heartbeat.status = 'error')::integer as worker_errors
    from worker_scope heartbeat
    left join worker_kind_activity on worker_kind_activity.worker_kind = heartbeat.worker_kind
  ), async_jobs as (
    select
      count(*)::integer as open_async_jobs,
      coalesce(sum(pending_units), 0)::integer as async_pending_units,
      coalesce(sum(failed_units), 0)::integer as async_failed_units,
      count(*) filter (
        where status in ('queued', 'pending', 'processing', 'paused')
          and age_seconds > (select async_job_age_warning_seconds from settings)
      )::integer as old_async_jobs
    from (
      select
        job.status::text as status,
        greatest(0, coalesce(job.expected_items, 0) - coalesce(job.generated_items, 0) - coalesce(job.failed_items, 0))::integer as pending_units,
        coalesce(job.failed_items, 0)::integer as failed_units,
        greatest(0, extract(epoch from ((select now_at from settings) - job.created_at))::integer) as age_seconds
      from public.publication_generation_jobs job
      where job.status in ('queued', 'processing', 'paused', 'failed')

      union all

      select
        job.status::text,
        greatest(0, coalesce(job.total_count, 0) - coalesce(job.processed_count, 0))::integer,
        coalesce(job.failed_count, 0)::integer,
        greatest(0, extract(epoch from ((select now_at from settings) - job.created_at))::integer)
      from public.media_deletion_jobs job
      where job.status in ('pending', 'processing', 'completed_with_errors', 'failed')

      union all

      select
        job.status::text,
        greatest(0, coalesce(job.total_count, 0) - coalesce(job.processed_count, 0))::integer,
        coalesce(job.failed_count, 0)::integer,
        greatest(0, extract(epoch from ((select now_at from settings) - job.created_at))::integer)
      from public.media_group_assignment_jobs job
      where job.status in ('pending', 'processing', 'completed_with_errors', 'failed')
    ) source
  ), throughput_summary as (
    select
      count(*) filter (where item.status = 'published' and item.published_at >= (select now_at from settings) - interval '1 hour')::integer as published_last_hour,
      count(*) filter (where item.status = 'published' and item.published_at >= (select now_at from settings) - interval '24 hours')::integer as published_last_24h,
      count(*) filter (where item.status = 'failed' and item.updated_at >= (select now_at from settings) - interval '1 hour')::integer as failed_last_hour
    from public.publication_items item
    where (item.status = 'published' and item.published_at >= (select now_at from settings) - interval '24 hours')
       or (item.status = 'failed' and item.updated_at >= (select now_at from settings) - interval '1 hour')
  ), combined as (
    select
      organizations_summary.organization_count,
      queue_summary.active_publication_items,
      queue_summary.expired_leases,
      queue_summary.due_retries,
      queue_summary.overdue_publications,
      queue_summary.max_lag_seconds,
      worker_summary.registered_workers,
      worker_summary.active_workers,
      worker_summary.stale_workers,
      worker_summary.worker_errors,
      async_jobs.open_async_jobs,
      async_jobs.async_pending_units,
      async_jobs.async_failed_units,
      async_jobs.old_async_jobs,
      throughput_summary.published_last_hour,
      throughput_summary.published_last_24h,
      throughput_summary.failed_last_hour,
      (
        queue_summary.expired_leases
        + queue_summary.overdue_publications
        + worker_summary.stale_workers
        + worker_summary.worker_errors
      )::integer as critical_signals,
      (
        queue_summary.due_retries
        + case when queue_summary.max_lag_seconds > (select queue_lag_warning_seconds from settings) then 1 else 0 end
        + async_jobs.async_failed_units
        + async_jobs.old_async_jobs
        + throughput_summary.failed_last_hour
      )::integer as warning_signals
    from organizations_summary, queue_summary, worker_summary, async_jobs, throughput_summary
  )
  select
    case
      when combined.critical_signals > 0 then 'unhealthy'
      when combined.warning_signals > 0 then 'degraded'
      else 'ok'
    end as health_status,
    combined.organization_count,
    combined.active_publication_items,
    combined.expired_leases,
    combined.due_retries,
    combined.overdue_publications,
    combined.max_lag_seconds,
    combined.registered_workers,
    combined.active_workers,
    combined.stale_workers,
    combined.worker_errors,
    combined.open_async_jobs,
    combined.async_pending_units,
    combined.async_failed_units,
    combined.old_async_jobs,
    combined.published_last_hour,
    combined.published_last_24h,
    combined.failed_last_hour,
    combined.critical_signals,
    combined.warning_signals
  from combined;
$$;

create or replace function public.prune_stale_publication_worker_heartbeats(
  p_older_than_hours integer default 24
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count integer;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Apenas service_role pode limpar heartbeats de workers.';
  end if;

  delete from public.publication_worker_heartbeats heartbeat
  where heartbeat.last_seen_at < timezone('utc', now()) - make_interval(hours => greatest(1, least(coalesce(p_older_than_hours, 24), 720)));

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.get_worker_operational_status(uuid, integer) from public, anon;
revoke all on function public.get_global_operational_health(integer, integer, integer) from public, anon, authenticated;
revoke all on function public.prune_stale_publication_worker_heartbeats(integer) from public, anon, authenticated;

grant execute on function public.get_worker_operational_status(uuid, integer) to authenticated, service_role;
grant execute on function public.get_global_operational_health(integer, integer, integer) to service_role;
grant execute on function public.prune_stale_publication_worker_heartbeats(integer) to service_role;
