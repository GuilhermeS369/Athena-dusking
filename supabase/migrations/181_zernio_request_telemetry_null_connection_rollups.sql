-- Faz o rollup também ser idempotente para a configuração Zernio legada por organização,
-- que não possui zernio_connection_id.

alter table public.zernio_publication_request_rollups
  add column if not exists zernio_connection_key uuid
  generated always as (coalesce(zernio_connection_id, '00000000-0000-0000-0000-000000000000'::uuid)) stored;

create unique index if not exists zernio_publication_request_rollups_identity_idx
  on public.zernio_publication_request_rollups (
    window_started_at,
    organization_id,
    zernio_connection_key,
    operation,
    outcome
  );

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
    ) on conflict (window_started_at, organization_id, zernio_connection_key, operation, outcome) do update set
      request_count = zernio_publication_request_rollups.request_count + excluded.request_count,
      duration_sum_ms = zernio_publication_request_rollups.duration_sum_ms + excluded.duration_sum_ms,
      duration_min_ms = least(zernio_publication_request_rollups.duration_min_ms, excluded.duration_min_ms),
      duration_max_ms = greatest(zernio_publication_request_rollups.duration_max_ms, excluded.duration_max_ms),
      latency_histogram = zernio_publication_request_rollups.latency_histogram || excluded.latency_histogram,
      updated_at = timezone('utc', now());
  end loop;

  for anomaly in select value from jsonb_array_elements(coalesce(p_anomalies, '[]'::jsonb)) loop
    if (anomaly->>'organization_id') is null
      or (anomaly->>'operation') not in ('create_post', 'get_post', 'disconnect_account')
      or (anomaly->>'outcome') not in ('timeout', 'http_error', 'network_error', 'parse_error') then
      continue;
    end if;

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

notify pgrst, 'reload schema';
