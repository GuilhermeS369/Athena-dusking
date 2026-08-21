-- Sinais duráveis de pressão na Zernio durante o refresh concorrente de analytics.
-- O log deliberadamente não contém token, URL, parâmetros de API ou payloads remotos.

create table if not exists public.profile_analytics_refresh_connection_pressure_events (
  id bigint generated always as identity primary key,
  job_id uuid not null references public.profile_analytics_refresh_jobs (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  zernio_connection_id uuid references public.zernio_connections (id) on delete set null,
  connection_key text not null check (char_length(connection_key) between 1 and 180),
  worker_id text check (char_length(coalesce(worker_id, '')) <= 120),
  error_class text not null check (error_class in ('timeout', 'rate_limit', 'unavailable')),
  error_code text not null check (char_length(error_code) between 1 and 160),
  global_concurrency integer not null check (global_concurrency between 1 and 20),
  connection_concurrency integer not null check (connection_concurrency between 1 and 10),
  consecutive_incidents integer not null check (consecutive_incidents >= 1),
  cooldown_ms integer not null check (cooldown_ms between 0 and 3600000),
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists profile_analytics_refresh_connection_pressure_org_created_idx
  on public.profile_analytics_refresh_connection_pressure_events (organization_id, created_at desc);

create index if not exists profile_analytics_refresh_connection_pressure_job_connection_idx
  on public.profile_analytics_refresh_connection_pressure_events (job_id, connection_key, created_at desc);

alter table public.profile_analytics_refresh_connection_pressure_events enable row level security;

create policy profile_analytics_refresh_connection_pressure_events_select_member
on public.profile_analytics_refresh_connection_pressure_events for select to authenticated
using (public.is_organization_member(organization_id));

revoke all on table public.profile_analytics_refresh_connection_pressure_events from public, anon;
grant select on table public.profile_analytics_refresh_connection_pressure_events to authenticated;
grant select, insert, update, delete on table public.profile_analytics_refresh_connection_pressure_events to service_role;

notify pgrst, 'reload schema';
