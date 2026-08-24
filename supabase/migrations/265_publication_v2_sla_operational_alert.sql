-- Expõe o SLA da esteira v2 na Central Operacional já existente. O alerta é
-- agregado e informativo: não altera nem encerra itens atrasados.

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
    select * from public.get_publication_queue_operational_summary(p_organization_id)
  ), worker_summary as (
    select * from public.get_worker_operational_status(p_organization_id, p_stale_after_seconds)
  ), async_summary as (
    select * from public.get_async_job_operational_summary(p_organization_id)
  ), sla_summary as (
    select coalesce(sum(alert.affected_item_count), 0)::integer as affected_items
    from public.publication_dispatch_sla_alerts alert
    where alert.organization_id = p_organization_id and alert.state = 'open'
  ), alerts as (
    select 'critical'::text as severity, 'expired_leases'::text as alert_kind,
      'Leases expirados na fila de publicação'::text as title,
      'Há publicações reivindicadas por worker cujo lease venceu e precisam de recuperação.'::text as detail,
      coalesce(sum(expired_leases), 0)::integer as total
    from queue_summary having coalesce(sum(expired_leases), 0) > 0

    union all
    select 'warning', 'due_retries', 'Retentativas vencidas aguardando processamento',
      'Existem publicações com próxima tentativa já vencida.', coalesce(sum(due_retries), 0)::integer
    from queue_summary having coalesce(sum(due_retries), 0) > 0

    union all
    select 'critical', 'overdue_publications', 'Publicações agendadas atrasadas',
      'Há itens waiting/ready que passaram da janela de execução esperada.', coalesce(sum(overdue), 0)::integer
    from queue_summary having coalesce(sum(overdue), 0) > 0

    union all
    select 'warning', 'publication_v2_sla', 'SLA de publicação v2 acima de 120 segundos',
      'Os itens continuam elegíveis e não foram descartados; o alerta fecha quando o slot termina.', affected_items
    from sla_summary where affected_items > 0

    union all
    select 'warning', 'queue_lag', 'Atraso máximo da fila acima do limite',
      'O maior atraso de itens ativos ultrapassou o limite de observação configurado.', coalesce(max(max_lag_seconds), 0)::integer
    from queue_summary
    having coalesce(max(max_lag_seconds), 0) > greatest(60, least(coalesce(p_queue_lag_warning_seconds, 300), 86400))

    union all
    select 'critical', 'stale_workers', 'Worker sem heartbeat recente',
      'Um ou mais workers dedicados deixaram de enviar heartbeat dentro da janela esperada.', count(*)::integer
    from worker_summary where is_stale or status = 'stopped' having count(*) > 0

    union all
    select 'critical', 'worker_errors', 'Worker em estado de erro',
      'Um ou mais workers reportaram erro no último heartbeat.', count(*)::integer
    from worker_summary where status = 'error' having count(*) > 0

    union all
    select 'warning', 'async_failed_units', 'Jobs assíncronos com falhas',
      'Há unidades com falha em jobs de geração, exclusão ou organização em grupos.', coalesce(sum(failed_units), 0)::integer
    from async_summary having coalesce(sum(failed_units), 0) > 0

    union all
    select 'warning', 'old_async_jobs', 'Jobs assíncronos antigos ainda abertos',
      'Há jobs grandes abertos há mais tempo que o limite operacional configurado.', count(*)::integer
    from async_summary
    where status in ('queued', 'pending', 'processing', 'paused')
      and max_age_seconds > greatest(300, least(coalesce(p_async_job_age_warning_seconds, 1800), 604800))
    having count(*) > 0
  )
  select severity, alert_kind, title, detail, total from alerts
  where public.is_system_super_user()
  order by case severity when 'critical' then 1 when 'warning' then 2 else 3 end, alert_kind;
$$;

revoke all on function public.get_operational_alerts(uuid, integer, integer, integer) from public, anon;
grant execute on function public.get_operational_alerts(uuid, integer, integer, integer) to authenticated, service_role;
notify pgrst, 'reload schema';
