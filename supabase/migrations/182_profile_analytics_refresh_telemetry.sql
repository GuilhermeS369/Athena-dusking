-- Telemetria agregada do refresh de métricas de perfil.
-- Mantém somente duração, etapa lógica e resultado normalizado; não armazena
-- tokens, URLs, parâmetros de API ou payloads retornados pela Zernio.

create table if not exists public.profile_analytics_refresh_step_events (
  id bigint generated always as identity primary key,
  job_id uuid not null references public.profile_analytics_refresh_jobs (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  profile_id uuid references public.instagram_profiles (id) on delete set null,
  worker_id text,
  step text not null check (step in (
    'worker_cycle',
    'connection_billing',
    'profile_lookup',
    'sync_run_create',
    'zernio_account_insights',
    'zernio_accounts',
    'zernio_follower_history',
    'zernio_post_analytics',
    'zernio_current_posts',
    'zernio_daily_metrics',
    'snapshot_persist',
    'daily_metrics_persist',
    'follower_history_persist',
    'post_analytics_persist',
    'item_complete'
  )),
  outcome text not null check (outcome in ('success', 'partial', 'error', 'skipped')),
  duration_ms integer not null check (duration_ms >= 0 and duration_ms <= 3600000),
  error_class text,
  error_code text,
  created_at timestamptz not null default timezone('utc', now()),
  check (char_length(coalesce(worker_id, '')) <= 120),
  check (char_length(coalesce(error_class, '')) <= 80),
  check (char_length(coalesce(error_code, '')) <= 160)
);

create index if not exists profile_analytics_refresh_step_events_org_created_idx
  on public.profile_analytics_refresh_step_events (organization_id, created_at desc);

create index if not exists profile_analytics_refresh_step_events_job_profile_created_idx
  on public.profile_analytics_refresh_step_events (job_id, profile_id, created_at desc);

alter table public.profile_analytics_refresh_step_events enable row level security;

create policy profile_analytics_refresh_step_events_select_member
on public.profile_analytics_refresh_step_events for select to authenticated
using (public.is_organization_member(organization_id));

revoke all on table public.profile_analytics_refresh_step_events from public, anon;
grant select on table public.profile_analytics_refresh_step_events to authenticated;
grant select, insert, update, delete on table public.profile_analytics_refresh_step_events to service_role;

create or replace function public.get_profile_analytics_refresh_telemetry(
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
  if not public.has_organization_role(p_organization_id, array['admin', 'operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  window_start := now_at - make_interval(hours => window_hours);

  with job_metrics as (
    select
      count(*)::integer as jobs,
      coalesce(sum(job.total_count), 0)::integer as profiles_requested,
      coalesce(sum(job.processed_count), 0)::integer as profiles_processed,
      coalesce(percentile_cont(0.50) within group (order by extract(epoch from (coalesce(job.finished_at, now_at) - job.created_at)) * 1000) filter (where job.status in ('completed', 'completed_with_errors')), 0)::integer as job_duration_p50_ms,
      coalesce(percentile_cont(0.95) within group (order by extract(epoch from (coalesce(job.finished_at, now_at) - job.created_at)) * 1000) filter (where job.status in ('completed', 'completed_with_errors')), 0)::integer as job_duration_p95_ms,
      coalesce(percentile_cont(0.95) within group (order by extract(epoch from (job.started_at - job.created_at)) * 1000) filter (where job.started_at is not null), 0)::integer as queue_wait_p95_ms
    from public.profile_analytics_refresh_jobs job
    where job.organization_id = p_organization_id
      and job.created_at >= window_start
  ), step_metrics as (
    select
      event.step,
      event.outcome,
      count(*)::integer as calls,
      coalesce(percentile_cont(0.50) within group (order by event.duration_ms), 0)::integer as duration_p50_ms,
      coalesce(percentile_cont(0.95) within group (order by event.duration_ms), 0)::integer as duration_p95_ms,
      coalesce(max(event.duration_ms), 0)::integer as duration_max_ms
    from public.profile_analytics_refresh_step_events event
    where event.organization_id = p_organization_id
      and event.created_at >= window_start
    group by event.step, event.outcome
  ), recent_errors as (
    select
      event.step,
      coalesce(nullif(event.error_class, ''), 'unknown') as error_class,
      coalesce(nullif(event.error_code, ''), 'unknown') as error_code,
      count(*)::integer as total
    from public.profile_analytics_refresh_step_events event
    where event.organization_id = p_organization_id
      and event.created_at >= window_start
      and event.outcome = 'error'
    group by event.step, coalesce(nullif(event.error_class, ''), 'unknown'), coalesce(nullif(event.error_code, ''), 'unknown')
  )
  select jsonb_build_object(
    'generatedAt', now_at,
    'windowHours', window_hours,
    'windowStart', window_start,
    'jobs', (select to_jsonb(metrics) from job_metrics metrics),
    'steps', coalesce((select jsonb_agg(to_jsonb(metrics) order by metrics.step, metrics.outcome) from step_metrics metrics), '[]'::jsonb),
    'errors', coalesce((select jsonb_agg(to_jsonb(errors) order by errors.total desc, errors.step) from recent_errors errors), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_profile_analytics_refresh_telemetry(uuid, integer) from public, anon;
grant execute on function public.get_profile_analytics_refresh_telemetry(uuid, integer) to authenticated, service_role;

notify pgrst, 'reload schema';
