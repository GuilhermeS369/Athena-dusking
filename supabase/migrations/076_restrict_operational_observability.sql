-- Restringe observabilidade operacional sensível ao superusuário do sistema.
-- Usuários comuns continuam vendo a Central Operacional da própria organização,
-- mas não podem acessar heartbeats, workers, jobs assíncronos, alertas globais
-- ou throughput operacional pelas RPCs/tabelas sensíveis.

create or replace function public.is_system_super_user()
returns boolean
language sql
stable
set search_path = public
as $$
  select auth.role() = 'service_role'
    or lower(coalesce(auth.jwt() ->> 'email', '')) = 'aleidar1010@gmail.com';
$$;

revoke all on function public.is_system_super_user() from public, anon;
grant execute on function public.is_system_super_user() to authenticated, service_role;

drop policy if exists publication_worker_heartbeats_select_admin on public.publication_worker_heartbeats;
drop policy if exists publication_worker_heartbeats_select_system_super_user on public.publication_worker_heartbeats;
create policy publication_worker_heartbeats_select_system_super_user
on public.publication_worker_heartbeats for select to authenticated
using (public.is_system_super_user());

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
    and public.is_system_super_user()
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
  where public.is_system_super_user()
  group by source.job_kind, source.status
  order by source.job_kind, source.status;
$$;

create or replace function public.get_operational_alerts(
  p_organization_id uuid,
  p_stale_after_seconds integer default 120,
  p_queue_lag_warning_seconds integer default 300,
  p_async_job_age_warning_seconds integer default 1800
)
returns table (
  severity text,
  alert_kind text,
  title text,
  detail text,
  total integer
)
language sql
stable
security definer
set search_path = public
as $$
  with queue_summary as (
    select *
    from public.get_publication_queue_operational_summary(p_organization_id)
  ), worker_summary as (
    select *
    from public.get_worker_operational_status(p_organization_id, p_stale_after_seconds)
  ), async_summary as (
    select *
    from public.get_async_job_operational_summary(p_organization_id)
  ), alerts as (
    select
      'critical'::text as severity,
      'expired_leases'::text as alert_kind,
      'Leases expirados na fila de publicação'::text as title,
      'Há publicações reivindicadas por worker cujo lease venceu e precisam de recuperação.'::text as detail,
      coalesce(sum(expired_leases), 0)::integer as total
    from queue_summary
    having coalesce(sum(expired_leases), 0) > 0

    union all

    select 'warning'::text, 'due_retries'::text, 'Retentativas vencidas aguardando processamento'::text, 'Existem publicações com próxima tentativa já vencida.'::text, coalesce(sum(due_retries), 0)::integer
    from queue_summary
    having coalesce(sum(due_retries), 0) > 0

    union all

    select 'critical'::text, 'overdue_publications'::text, 'Publicações agendadas atrasadas'::text, 'Há itens waiting/ready que passaram da janela de execução esperada.'::text, coalesce(sum(overdue), 0)::integer
    from queue_summary
    having coalesce(sum(overdue), 0) > 0

    union all

    select 'warning'::text, 'queue_lag'::text, 'Atraso máximo da fila acima do limite'::text, 'O maior atraso de itens ativos ultrapassou o limite de observação configurado.'::text, coalesce(max(max_lag_seconds), 0)::integer
    from queue_summary
    having coalesce(max(max_lag_seconds), 0) > greatest(60, least(coalesce(p_queue_lag_warning_seconds, 300), 86400))

    union all

    select 'critical'::text, 'stale_workers'::text, 'Worker sem heartbeat recente'::text, 'Um ou mais workers dedicados deixaram de enviar heartbeat dentro da janela esperada.'::text, count(*)::integer
    from worker_summary
    where is_stale or status = 'stopped'
    having count(*) > 0

    union all

    select 'critical'::text, 'worker_errors'::text, 'Worker em estado de erro'::text, 'Um ou mais workers reportaram erro no último heartbeat.'::text, count(*)::integer
    from worker_summary
    where status = 'error'
    having count(*) > 0

    union all

    select 'warning'::text, 'async_failed_units'::text, 'Jobs assíncronos com falhas'::text, 'Há unidades com falha em jobs de geração, exclusão ou organização em grupos.'::text, coalesce(sum(failed_units), 0)::integer
    from async_summary
    having coalesce(sum(failed_units), 0) > 0

    union all

    select 'warning'::text, 'old_async_jobs'::text, 'Jobs assíncronos antigos ainda abertos'::text, 'Há jobs grandes abertos há mais tempo que o limite operacional configurado.'::text, count(*)::integer
    from async_summary
    where status in ('queued', 'pending', 'processing', 'paused')
      and max_age_seconds > greatest(300, least(coalesce(p_async_job_age_warning_seconds, 1800), 604800))
    having count(*) > 0
  )
  select severity, alert_kind, title, detail, total
  from alerts
  where public.is_system_super_user()
  order by case severity when 'critical' then 1 when 'warning' then 2 else 3 end, alert_kind;
$$;

create or replace function public.get_publication_throughput_summary(
  p_organization_id uuid,
  p_hours integer default 24
)
returns table (
  window_label text,
  window_start timestamptz,
  published_count integer,
  failed_count integer,
  attempted_count integer,
  unique_profiles integer,
  average_publish_lag_seconds integer,
  max_publish_lag_seconds integer
)
language sql
stable
security definer
set search_path = public
as $$
  with bounds as (
    select
      timezone('utc', now()) as now_at,
      greatest(1, least(coalesce(p_hours, 24), 168)) as hours_back
  ), windows as (
    select '15m'::text as window_label, now_at - interval '15 minutes' as window_start from bounds
    union all select '1h', now_at - interval '1 hour' from bounds
    union all select '24h', now_at - interval '24 hours' from bounds
    union all select 'custom', now_at - make_interval(hours => hours_back) from bounds
  ), eligible_items as (
    select item.*
    from public.publication_items item
    where item.organization_id = p_organization_id
      and public.is_system_super_user()
      and (
        (item.status = 'published' and item.published_at is not null and item.published_at >= (select min(window_start) from windows))
        or (item.status = 'failed' and item.updated_at >= (select min(window_start) from windows))
      )
  )
  select
    window_row.window_label,
    window_row.window_start,
    count(*) filter (where item.status = 'published' and item.published_at >= window_row.window_start)::integer as published_count,
    count(*) filter (where item.status = 'failed' and item.updated_at >= window_row.window_start)::integer as failed_count,
    count(*) filter (
      where (item.status = 'published' and item.published_at >= window_row.window_start)
         or (item.status = 'failed' and item.updated_at >= window_row.window_start)
    )::integer as attempted_count,
    count(distinct item.profile_id) filter (
      where item.status = 'published' and item.published_at >= window_row.window_start
    )::integer as unique_profiles,
    coalesce(avg(greatest(0, extract(epoch from (item.published_at - item.execute_at))::integer)) filter (
      where item.status = 'published'
        and item.published_at >= window_row.window_start
        and item.execute_at is not null
    ), 0)::integer as average_publish_lag_seconds,
    coalesce(max(greatest(0, extract(epoch from (item.published_at - item.execute_at))::integer)) filter (
      where item.status = 'published'
        and item.published_at >= window_row.window_start
        and item.execute_at is not null
    ), 0)::integer as max_publish_lag_seconds
  from windows window_row
  left join eligible_items item on true
  group by window_row.window_label, window_row.window_start
  order by case window_row.window_label when '15m' then 1 when '1h' then 2 when '24h' then 3 else 4 end;
$$;

revoke all on function public.get_worker_operational_status(uuid, integer) from public, anon;
revoke all on function public.get_async_job_operational_summary(uuid) from public, anon;
revoke all on function public.get_operational_alerts(uuid, integer, integer, integer) from public, anon;
revoke all on function public.get_publication_throughput_summary(uuid, integer) from public, anon;

grant execute on function public.get_worker_operational_status(uuid, integer) to authenticated, service_role;
grant execute on function public.get_async_job_operational_summary(uuid) to authenticated, service_role;
grant execute on function public.get_operational_alerts(uuid, integer, integer, integer) to authenticated, service_role;
grant execute on function public.get_publication_throughput_summary(uuid, integer) to authenticated, service_role;
