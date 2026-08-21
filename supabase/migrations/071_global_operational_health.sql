-- Health check operacional consolidado para monitoramento externo.
-- Retorna um resumo global do ambiente sem depender de sessão de usuário.

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
  ), worker_summary as (
    select
      count(*)::integer as registered_workers,
      count(*) filter (
        where heartbeat.last_seen_at >= (select now_at from settings) - make_interval(secs => (select stale_after_seconds from settings))
          and heartbeat.status not in ('stopped', 'error')
      )::integer as active_workers,
      count(*) filter (
        where heartbeat.last_seen_at < (select now_at from settings) - make_interval(secs => (select stale_after_seconds from settings))
          or heartbeat.status = 'stopped'
      )::integer as stale_workers,
      count(*) filter (where heartbeat.status = 'error')::integer as worker_errors
    from public.publication_worker_heartbeats heartbeat
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

revoke all on function public.get_global_operational_health(integer, integer, integer) from public, anon, authenticated;
grant execute on function public.get_global_operational_health(integer, integer, integer) to service_role;
