-- Base operacional para workers dedicados, health checks agregados e migração segura para VPS.
-- Esta migration não altera nem remove publicações já agendadas; apenas adiciona
-- configuração, heartbeat e leituras agregadas para operar filas em escala.

create table if not exists public.publication_worker_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations (id) on delete cascade,
  worker_kind text not null default 'publication' check (worker_kind in ('publication', 'publication_planner', 'media_deletion', 'media_processing')),
  enabled boolean not null default true,
  dry_run boolean not null default true,
  claim_limit integer not null default 5 check (claim_limit between 1 and 100),
  concurrency_limit integer not null default 2 check (concurrency_limit between 1 and 50),
  lease_seconds integer not null default 180 check (lease_seconds between 30 and 900),
  poll_interval_ms integer not null default 3000 check (poll_interval_ms between 500 and 60000),
  max_daily_profile_publications integer not null default 100 check (max_daily_profile_publications between 1 and 1000),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists publication_worker_settings_global_kind_idx
  on public.publication_worker_settings (worker_kind)
  where organization_id is null;

create unique index if not exists publication_worker_settings_org_kind_idx
  on public.publication_worker_settings (organization_id, worker_kind)
  where organization_id is not null;

create trigger publication_worker_settings_set_updated_at
before update on public.publication_worker_settings
for each row execute function public.set_updated_at();

create table if not exists public.publication_worker_heartbeats (
  worker_id text primary key check (char_length(trim(worker_id)) between 3 and 120),
  worker_kind text not null default 'publication' check (worker_kind in ('publication', 'publication_planner', 'media_deletion', 'media_processing')),
  status text not null default 'starting' check (status in ('starting', 'observing', 'idle', 'dispatching', 'processing', 'stopping', 'stopped', 'error')),
  dry_run boolean not null default true,
  version text,
  hostname text,
  process_id integer,
  started_at timestamptz not null default timezone('utc', now()),
  last_seen_at timestamptz not null default timezone('utc', now()),
  last_error_message text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists publication_worker_heartbeats_kind_seen_idx
  on public.publication_worker_heartbeats (worker_kind, last_seen_at desc);

alter table public.publication_worker_settings enable row level security;
alter table public.publication_worker_heartbeats enable row level security;

drop policy if exists publication_worker_settings_select_member on public.publication_worker_settings;
create policy publication_worker_settings_select_member
on public.publication_worker_settings for select to authenticated
using (organization_id is not null and public.is_organization_member(organization_id));

drop policy if exists publication_worker_settings_update_admin on public.publication_worker_settings;
create policy publication_worker_settings_update_admin
on public.publication_worker_settings for update to authenticated
using (organization_id is not null and public.has_organization_role(organization_id, array['admin']::public.organization_role[]))
with check (organization_id is not null and public.has_organization_role(organization_id, array['admin']::public.organization_role[]));

drop policy if exists publication_worker_settings_insert_admin on public.publication_worker_settings;
create policy publication_worker_settings_insert_admin
on public.publication_worker_settings for insert to authenticated
with check (organization_id is not null and public.has_organization_role(organization_id, array['admin']::public.organization_role[]));

drop policy if exists publication_worker_heartbeats_select_admin on public.publication_worker_heartbeats;
create policy publication_worker_heartbeats_select_admin
on public.publication_worker_heartbeats for select to authenticated
using (exists (
  select 1
  from public.organization_members member
  where member.user_id = (select auth.uid())
    and member.role = 'admin'
));

create or replace function public.upsert_publication_worker_heartbeat(
  p_worker_id text,
  p_worker_kind text default 'publication',
  p_status text default 'idle',
  p_dry_run boolean default true,
  p_version text default null,
  p_hostname text default null,
  p_process_id integer default null,
  p_last_error_message text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns public.publication_worker_heartbeats
language plpgsql
security definer
set search_path = public
as $$
declare
  heartbeat_row public.publication_worker_heartbeats;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Apenas service_role pode registrar heartbeat de worker.';
  end if;
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido.';
  end if;
  if p_worker_kind not in ('publication', 'publication_planner', 'media_deletion', 'media_processing') then
    raise exception using errcode = '22023', message = 'Tipo de worker inválido.';
  end if;
  if p_status not in ('starting', 'observing', 'idle', 'dispatching', 'processing', 'stopping', 'stopped', 'error') then
    raise exception using errcode = '22023', message = 'Status de worker inválido.';
  end if;

  insert into public.publication_worker_heartbeats (
    worker_id, worker_kind, status, dry_run, version, hostname, process_id,
    last_error_message, metadata, started_at, last_seen_at
  ) values (
    trim(p_worker_id), p_worker_kind, p_status, p_dry_run, nullif(trim(coalesce(p_version, '')), ''),
    nullif(trim(coalesce(p_hostname, '')), ''), p_process_id, left(nullif(trim(coalesce(p_last_error_message, '')), ''), 1200),
    coalesce(p_metadata, '{}'::jsonb), timezone('utc', now()), timezone('utc', now())
  )
  on conflict (worker_id) do update
  set
    worker_kind = excluded.worker_kind,
    status = excluded.status,
    dry_run = excluded.dry_run,
    version = excluded.version,
    hostname = excluded.hostname,
    process_id = excluded.process_id,
    last_error_message = excluded.last_error_message,
    metadata = excluded.metadata,
    last_seen_at = timezone('utc', now())
  returning * into heartbeat_row;

  return heartbeat_row;
end;
$$;

create or replace function public.get_publication_queue_operational_summary(
  p_organization_id uuid default null
)
returns table (
  organization_id uuid,
  status public.publication_item_status,
  total integer,
  expired_leases integer,
  due_retries integer,
  overdue integer,
  oldest_execute_at timestamptz,
  max_lag_seconds integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    item.organization_id,
    item.status,
    count(*)::integer as total,
    count(*) filter (
      where item.lease_until is not null
        and item.lease_until <= timezone('utc', now())
    )::integer as expired_leases,
    count(*) filter (
      where item.status = 'failed'
        and item.next_attempt_at is not null
        and item.next_attempt_at <= timezone('utc', now())
    )::integer as due_retries,
    count(*) filter (
      where item.status in ('waiting', 'ready')
        and item.execute_at is not null
        and item.execute_at < timezone('utc', now()) - interval '120 seconds'
    )::integer as overdue,
    min(item.execute_at) filter (where item.execute_at is not null) as oldest_execute_at,
    coalesce(max(greatest(0, extract(epoch from (timezone('utc', now()) - item.execute_at))::integer)) filter (
      where item.execute_at is not null
        and item.execute_at < timezone('utc', now())
        and item.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed')
    ), 0)::integer as max_lag_seconds
  from public.publication_items item
  where item.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed')
    and (p_organization_id is null or item.organization_id = p_organization_id)
    and (auth.role() = 'service_role' or public.is_organization_member(item.organization_id))
  group by item.organization_id, item.status
  order by item.organization_id, item.status;
$$;

revoke all on table public.publication_worker_settings from anon;
revoke all on table public.publication_worker_heartbeats from anon;
grant select, insert, update on table public.publication_worker_settings to authenticated;
grant select on table public.publication_worker_heartbeats to authenticated;

revoke all on function public.upsert_publication_worker_heartbeat(text, text, text, boolean, text, text, integer, text, jsonb) from public, anon, authenticated;
grant execute on function public.upsert_publication_worker_heartbeat(text, text, text, boolean, text, text, integer, text, jsonb) to service_role;

revoke all on function public.get_publication_queue_operational_summary(uuid) from public, anon;
grant execute on function public.get_publication_queue_operational_summary(uuid) to authenticated, service_role;
