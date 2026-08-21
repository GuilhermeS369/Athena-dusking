-- Telemetria operacional agregada de publicação.
-- Não cria logs por postagem: consulta os estados, eventos e ciclos já duráveis.

create index if not exists publication_item_events_org_type_code_created_idx
  on public.publication_item_events (organization_id, event_type, error_code, created_at desc);

create or replace function public.get_publication_dispatch_telemetry(
  p_organization_id uuid,
  p_hours integer default 24
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  now_at timestamptz := timezone('utc', now());
  window_hours integer := greatest(1, least(coalesce(p_hours, 24), 168));
  window_start timestamptz;
  result jsonb;
begin
  if not public.is_system_super_user() then
    raise exception using errcode = '42501', message = 'Telemetria de publicação disponível somente ao superusuário do sistema.';
  end if;

  window_start := now_at - make_interval(hours => window_hours);

  with provider_metrics as (
    select
      profile.provider::text as provider,
      count(*) filter (where item.status = 'published' and item.published_at >= window_start)::integer as published_count,
      count(*) filter (where item.status = 'failed' and item.updated_at >= window_start)::integer as failed_count,
      count(distinct item.profile_id) filter (where item.status = 'published' and item.published_at >= window_start)::integer as unique_profiles,
      coalesce(percentile_cont(0.95) within group (
        order by greatest(0, extract(epoch from (item.published_at - item.execute_at)))
      ) filter (where item.status = 'published' and item.published_at >= window_start and item.execute_at is not null), 0)::integer as publish_lag_p95_seconds,
      coalesce(max(greatest(0, extract(epoch from (item.published_at - item.execute_at))::integer)) filter (
        where item.status = 'published' and item.published_at >= window_start and item.execute_at is not null
      ), 0)::integer as publish_lag_max_seconds
    from public.publication_items item
    join public.instagram_profiles profile on profile.id = item.profile_id
    where item.organization_id = p_organization_id
      and (
        (item.status = 'published' and item.published_at >= window_start)
        or (item.status = 'failed' and item.updated_at >= window_start)
      )
    group by profile.provider
  ), provider_deferred as (
    select
      profile.provider::text as provider,
      count(*) filter (where event.event_type = 'processing_deferred')::integer as deferred_count,
      count(*) filter (where event.event_type = 'retry_requested')::integer as retry_requested_count
    from public.publication_item_events event
    join public.publication_items item on item.id = event.publication_item_id
    join public.instagram_profiles profile on profile.id = item.profile_id
    where event.organization_id = p_organization_id
      and event.created_at >= window_start
    group by profile.provider
  ), providers as (
    select
      coalesce(metric.provider, deferred.provider) as provider,
      coalesce(metric.published_count, 0) as published_count,
      coalesce(metric.failed_count, 0) as failed_count,
      coalesce(deferred.deferred_count, 0) as deferred_count,
      coalesce(deferred.retry_requested_count, 0) as retry_requested_count,
      coalesce(metric.unique_profiles, 0) as unique_profiles,
      coalesce(metric.publish_lag_p95_seconds, 0) as publish_lag_p95_seconds,
      coalesce(metric.publish_lag_max_seconds, 0) as publish_lag_max_seconds
    from provider_metrics metric
    full join provider_deferred deferred on deferred.provider = metric.provider
  ), grouped_errors as (
    select
      profile.provider::text as provider,
      coalesce(nullif(event.error_code, ''), case when event.event_type = 'failed' then 'unknown_failure' else 'unknown_event_error' end) as error_code,
      count(*)::integer as total,
      min(event.created_at) as first_seen_at,
      max(event.created_at) as last_seen_at,
      (array_agg(left(coalesce(nullif(event.error_message, ''), 'Sem mensagem fornecida.'), 240) order by event.created_at desc))[1] as latest_message
    from public.publication_item_events event
    join public.publication_items item on item.id = event.publication_item_id
    join public.instagram_profiles profile on profile.id = item.profile_id
    where event.organization_id = p_organization_id
      and event.created_at >= window_start
      and (event.error_code is not null or event.event_type = 'failed')
    group by profile.provider, coalesce(nullif(event.error_code, ''), case when event.event_type = 'failed' then 'unknown_failure' else 'unknown_event_error' end)
  ), cycle_metrics as (
    select
      count(*) filter (where event.phase = 'completed')::integer as completed_cycles,
      count(*) filter (where event.phase = 'failed')::integer as failed_cycles,
      coalesce(percentile_cont(0.50) within group (order by event.duration_ms) filter (where event.phase = 'completed'), 0)::integer as cycle_duration_p50_ms,
      coalesce(percentile_cont(0.95) within group (order by event.duration_ms) filter (where event.phase = 'completed'), 0)::integer as cycle_duration_p95_ms,
      coalesce(sum(coalesce((event.metadata #>> '{dispatch,claimed}')::integer, 0)) filter (where event.phase = 'completed'), 0)::integer as claimed_count,
      coalesce(sum(coalesce((event.metadata #>> '{dispatch,outcomes,published}')::integer, 0)) filter (where event.phase = 'completed'), 0)::integer as cycle_published_count,
      coalesce(sum(coalesce((event.metadata #>> '{dispatch,outcomes,failed}')::integer, 0)) filter (where event.phase = 'completed'), 0)::integer as cycle_failed_count,
      coalesce(sum(coalesce((event.metadata #>> '{dispatch,outcomes,dispatch_rate_limit}')::integer, 0)) filter (where event.phase = 'completed'), 0)::integer as rate_limited_count
    from public.publication_worker_cycle_events event
    where event.worker_kind = 'publication'
      and event.created_at >= window_start
  ), queue_metrics as (
    select
      coalesce(sum(summary.total), 0)::integer as active_items,
      coalesce(sum(summary.expired_leases), 0)::integer as expired_leases,
      coalesce(sum(summary.due_retries), 0)::integer as due_retries,
      coalesce(sum(summary.overdue), 0)::integer as overdue,
      coalesce(max(summary.max_lag_seconds), 0)::integer as max_lag_seconds
    from public.get_publication_queue_operational_summary(p_organization_id) summary
  ), alert_rows as (
    select 'critical'::text as severity, 'dispatch_overdue'::text as kind,
      'Publicações atrasadas na janela atual'::text as title,
      'Existem itens ativos que ultrapassaram o horário previsto de publicação.'::text as detail,
      queue.overdue as total
    from queue_metrics queue where queue.overdue > 0

    union all

    select 'critical', 'dispatch_expired_leases', 'Leases de publicação expirados',
      'Itens podem exigir recuperação porque um worker não concluiu seu lease.', queue.expired_leases
    from queue_metrics queue where queue.expired_leases > 0

    union all

    select 'warning', 'dispatch_backlog_lag', 'Atraso máximo de fila elevado',
      'O maior atraso ativo ultrapassou cinco minutos.', queue.max_lag_seconds
    from queue_metrics queue where queue.max_lag_seconds > 300

    union all

    select 'warning', 'dispatch_failure_rate', 'Taxa recente de falha elevada',
      'A janela teve ao menos 10 tentativas e mais de 10% delas falharam para um provedor.', provider.failed_count
    from providers provider
    where provider.published_count + provider.failed_count >= 10
      and provider.failed_count::numeric / nullif(provider.published_count + provider.failed_count, 0) > 0.10

    union all

    select 'warning', 'dispatch_cycle_failures', 'Ciclos do worker falharam',
      'O worker registrou ciclos interrompidos na janela selecionada.', cycles.failed_cycles
    from cycle_metrics cycles where cycles.failed_cycles > 0
  )
  select jsonb_build_object(
    'generatedAt', now_at,
    'windowHours', window_hours,
    'windowStart', window_start,
    'providers', coalesce((select jsonb_agg(to_jsonb(provider) order by provider.provider) from providers provider), '[]'::jsonb),
    'errors', coalesce((select jsonb_agg(to_jsonb(grouped_error) order by grouped_error.total desc, grouped_error.last_seen_at desc) from grouped_errors grouped_error), '[]'::jsonb),
    'cycles', (select to_jsonb(cycles) from cycle_metrics cycles),
    'queue', (select to_jsonb(queue) from queue_metrics queue),
    'alerts', coalesce((select jsonb_agg(to_jsonb(alert) order by case alert.severity when 'critical' then 1 else 2 end, alert.kind) from alert_rows alert), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_publication_dispatch_telemetry(uuid, integer) from public, anon;
grant execute on function public.get_publication_dispatch_telemetry(uuid, integer) to authenticated, service_role;

notify pgrst, 'reload schema';
