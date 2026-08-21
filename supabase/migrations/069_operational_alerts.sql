-- Alertas operacionais agregados para a Central Operacional.
-- A função retorna apenas sinais consolidados de risco, evitando varreduras e
-- filtros client-side em filas grandes.

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

    select
      'warning'::text,
      'due_retries'::text,
      'Retentativas vencidas aguardando processamento'::text,
      'Existem publicações com próxima tentativa já vencida.'::text,
      coalesce(sum(due_retries), 0)::integer
    from queue_summary
    having coalesce(sum(due_retries), 0) > 0

    union all

    select
      'critical'::text,
      'overdue_publications'::text,
      'Publicações agendadas atrasadas'::text,
      'Há itens waiting/ready que passaram da janela de execução esperada.'::text,
      coalesce(sum(overdue), 0)::integer
    from queue_summary
    having coalesce(sum(overdue), 0) > 0

    union all

    select
      'warning'::text,
      'queue_lag'::text,
      'Atraso máximo da fila acima do limite'::text,
      'O maior atraso de itens ativos ultrapassou o limite de observação configurado.'::text,
      coalesce(max(max_lag_seconds), 0)::integer
    from queue_summary
    having coalesce(max(max_lag_seconds), 0) > greatest(60, least(coalesce(p_queue_lag_warning_seconds, 300), 86400))

    union all

    select
      'critical'::text,
      'stale_workers'::text,
      'Worker sem heartbeat recente'::text,
      'Um ou mais workers dedicados deixaram de enviar heartbeat dentro da janela esperada.'::text,
      count(*)::integer
    from worker_summary
    where is_stale or status = 'stopped'
    having count(*) > 0

    union all

    select
      'critical'::text,
      'worker_errors'::text,
      'Worker em estado de erro'::text,
      'Um ou mais workers reportaram erro no último heartbeat.'::text,
      count(*)::integer
    from worker_summary
    where status = 'error'
    having count(*) > 0

    union all

    select
      'warning'::text,
      'async_failed_units'::text,
      'Jobs assíncronos com falhas'::text,
      'Há unidades com falha em jobs de geração, exclusão ou organização em grupos.'::text,
      coalesce(sum(failed_units), 0)::integer
    from async_summary
    having coalesce(sum(failed_units), 0) > 0

    union all

    select
      'warning'::text,
      'old_async_jobs'::text,
      'Jobs assíncronos antigos ainda abertos'::text,
      'Há jobs grandes abertos há mais tempo que o limite operacional configurado.'::text,
      count(*)::integer
    from async_summary
    where status in ('queued', 'pending', 'processing', 'paused')
      and max_age_seconds > greatest(300, least(coalesce(p_async_job_age_warning_seconds, 1800), 604800))
    having count(*) > 0
  )
  select severity, alert_kind, title, detail, total
  from alerts
  order by case severity when 'critical' then 1 when 'warning' then 2 else 3 end, alert_kind;
$$;

revoke all on function public.get_operational_alerts(uuid, integer, integer, integer) from public, anon;
grant execute on function public.get_operational_alerts(uuid, integer, integer, integer) to authenticated, service_role;
