-- Telemetria de chamadas Zernio e limpeza somente da visualização operacional.
-- Os eventos originais da fila nunca são apagados por esta migration.

create table if not exists public.zernio_publication_request_rollups (
  id uuid primary key default gen_random_uuid(),
  window_started_at timestamptz not null,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  zernio_connection_id uuid references public.zernio_connections(id) on delete set null,
  operation text not null check (operation in ('create_post', 'get_post', 'disconnect_account')),
  outcome text not null check (outcome in ('succeeded', 'timeout', 'http_error', 'network_error', 'parse_error')),
  request_count integer not null default 0 check (request_count >= 0),
  duration_sum_ms bigint not null default 0 check (duration_sum_ms >= 0),
  duration_min_ms integer,
  duration_max_ms integer,
  latency_histogram jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default timezone('utc', now()),
  unique (window_started_at, organization_id, zernio_connection_id, operation, outcome)
);

create index if not exists zernio_publication_request_rollups_org_window_idx
  on public.zernio_publication_request_rollups (organization_id, window_started_at desc);
create index if not exists zernio_publication_request_rollups_connection_window_idx
  on public.zernio_publication_request_rollups (zernio_connection_id, window_started_at desc);

create table if not exists public.zernio_publication_request_anomalies (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default timezone('utc', now()),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  zernio_connection_id uuid references public.zernio_connections(id) on delete set null,
  publication_item_id uuid references public.publication_items(id) on delete set null,
  batch_id uuid references public.publication_batches(id) on delete set null,
  correlation_id uuid,
  operation text not null check (operation in ('create_post', 'get_post', 'disconnect_account')),
  outcome text not null check (outcome in ('timeout', 'http_error', 'network_error', 'parse_error')),
  duration_ms integer not null check (duration_ms >= 0),
  timeout_ms integer not null check (timeout_ms > 0),
  http_status integer,
  provider_code text,
  provider_request_id text,
  error_message text,
  attempt_count integer,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists zernio_publication_request_anomalies_org_occurred_idx
  on public.zernio_publication_request_anomalies (organization_id, occurred_at desc);
create index if not exists zernio_publication_request_anomalies_connection_occurred_idx
  on public.zernio_publication_request_anomalies (zernio_connection_id, occurred_at desc);

alter table public.zernio_publication_request_rollups enable row level security;
alter table public.zernio_publication_request_anomalies enable row level security;
revoke all on public.zernio_publication_request_rollups, public.zernio_publication_request_anomalies from public, anon, authenticated;
grant all on public.zernio_publication_request_rollups, public.zernio_publication_request_anomalies to service_role;

create or replace function public.record_zernio_publication_request_telemetry(p_rollups jsonb, p_anomalies jsonb default '[]'::jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  entry jsonb;
  anomaly jsonb;
  target_window timestamptz;
  target_organization uuid;
  target_connection uuid;
  target_operation text;
  target_outcome text;
  histogram jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Telemetria de worker permitida somente ao service_role.';
  end if;

  for entry in select value from jsonb_array_elements(coalesce(p_rollups, '[]'::jsonb)) loop
    target_window := date_trunc('hour', (entry->>'window_started_at')::timestamptz)
      + make_interval(mins => (extract(minute from (entry->>'window_started_at')::timestamptz)::integer / 5) * 5);
    target_organization := (entry->>'organization_id')::uuid;
    target_connection := nullif(entry->>'zernio_connection_id', '')::uuid;
    target_operation := entry->>'operation';
    target_outcome := entry->>'outcome';
    histogram := coalesce(entry->'latency_histogram', '{}'::jsonb);

    if target_organization is null or target_operation not in ('create_post', 'get_post', 'disconnect_account')
      or target_outcome not in ('succeeded', 'timeout', 'http_error', 'network_error', 'parse_error') then
      continue;
    end if;

    insert into public.zernio_publication_request_rollups (
      window_started_at, organization_id, zernio_connection_id, operation, outcome,
      request_count, duration_sum_ms, duration_min_ms, duration_max_ms, latency_histogram
    ) values (
      target_window, target_organization, target_connection, target_operation, target_outcome,
      greatest(0, coalesce((entry->>'request_count')::integer, 0)),
      greatest(0, coalesce((entry->>'duration_sum_ms')::bigint, 0)),
      nullif(entry->>'duration_min_ms', '')::integer,
      nullif(entry->>'duration_max_ms', '')::integer,
      histogram
    ) on conflict (window_started_at, organization_id, zernio_connection_id, operation, outcome) do update set
      request_count = zernio_publication_request_rollups.request_count + excluded.request_count,
      duration_sum_ms = zernio_publication_request_rollups.duration_sum_ms + excluded.duration_sum_ms,
      duration_min_ms = least(zernio_publication_request_rollups.duration_min_ms, excluded.duration_min_ms),
      duration_max_ms = greatest(zernio_publication_request_rollups.duration_max_ms, excluded.duration_max_ms),
      latency_histogram = zernio_publication_request_rollups.latency_histogram || excluded.latency_histogram,
      updated_at = timezone('utc', now());
  end loop;

  for anomaly in select value from jsonb_array_elements(coalesce(p_anomalies, '[]'::jsonb)) loop
    if (anomaly->>'organization_id') is null then continue; end if;
    insert into public.zernio_publication_request_anomalies (
      occurred_at, organization_id, zernio_connection_id, publication_item_id, batch_id, correlation_id,
      operation, outcome, duration_ms, timeout_ms, http_status, provider_code, provider_request_id,
      error_message, attempt_count
    ) values (
      coalesce((anomaly->>'occurred_at')::timestamptz, timezone('utc', now())),
      (anomaly->>'organization_id')::uuid,
      nullif(anomaly->>'zernio_connection_id', '')::uuid,
      nullif(anomaly->>'publication_item_id', '')::uuid,
      nullif(anomaly->>'batch_id', '')::uuid,
      nullif(anomaly->>'correlation_id', '')::uuid,
      anomaly->>'operation', anomaly->>'outcome', greatest(0, coalesce((anomaly->>'duration_ms')::integer, 0)),
      greatest(1, coalesce((anomaly->>'timeout_ms')::integer, 25000)), nullif(anomaly->>'http_status', '')::integer,
      left(coalesce(anomaly->>'provider_code', ''), 120), left(coalesce(anomaly->>'provider_request_id', ''), 240),
      left(coalesce(anomaly->>'error_message', ''), 600), nullif(anomaly->>'attempt_count', '')::integer
    );
  end loop;
end;
$$;

revoke all on function public.record_zernio_publication_request_telemetry(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.record_zernio_publication_request_telemetry(jsonb, jsonb) to service_role;

create table if not exists public.operational_log_clear_actions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  actor_user_id uuid not null references auth.users(id) on delete cascade,
  scope_key text not null check (scope_key in ('attention_items', 'publication_events')),
  cleared_at timestamptz not null default timezone('utc', now()),
  undone_at timestamptz,
  undone_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (organization_id, actor_user_id, scope_key)
);

create index if not exists operational_log_clear_actions_actor_idx
  on public.operational_log_clear_actions (organization_id, actor_user_id, scope_key);
alter table public.operational_log_clear_actions enable row level security;
create policy operational_log_clear_actions_select_own on public.operational_log_clear_actions
  for select to authenticated using (actor_user_id = (select auth.uid()) and public.is_organization_member(organization_id));

create or replace function public.set_operational_log_visibility(p_organization_id uuid, p_scope_key text, p_action text)
returns public.operational_log_clear_actions
language plpgsql
security definer
set search_path = public
as $$
declare
  action_row public.operational_log_clear_actions;
  actor_id uuid := auth.uid();
begin
  if actor_id is null or not public.has_organization_role(p_organization_id, array['admin', 'operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Sem permissão para limpar a visualização operacional.';
  end if;
  if p_scope_key not in ('attention_items', 'publication_events') or p_action not in ('clear', 'undo') then
    raise exception using errcode = '22023', message = 'Escopo ou ação inválidos.';
  end if;

  insert into public.operational_log_clear_actions (organization_id, actor_user_id, scope_key, cleared_at, undone_at, undone_by, updated_at)
  values (p_organization_id, actor_id, p_scope_key, timezone('utc', now()), case when p_action = 'undo' then timezone('utc', now()) else null end, case when p_action = 'undo' then actor_id else null end, timezone('utc', now()))
  on conflict (organization_id, actor_user_id, scope_key) do update set
    cleared_at = case when p_action = 'clear' then timezone('utc', now()) else operational_log_clear_actions.cleared_at end,
    undone_at = case when p_action = 'undo' then timezone('utc', now()) else null end,
    undone_by = case when p_action = 'undo' then actor_id else null end,
    updated_at = timezone('utc', now())
  returning * into action_row;
  return action_row;
end;
$$;

revoke all on function public.set_operational_log_visibility(uuid, text, text) from public, anon;
grant execute on function public.set_operational_log_visibility(uuid, text, text) to authenticated, service_role;

notify pgrst, 'reload schema';
