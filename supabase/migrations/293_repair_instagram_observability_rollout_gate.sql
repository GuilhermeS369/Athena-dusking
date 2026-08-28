-- Repara os bloqueios encontrados no gate de 24 horas da Central Instagram.
-- Mudanças forward-only: telemetria agregada mais precisa, retenção exata em
-- partição de borda, manutenção legada indexada/isolável e fingerprints estáveis.

alter table public.instagram_observability_api_rollups_5m
  add column if not exists duration_le_300_count bigint not null default 0 check (duration_le_300_count >= 0),
  add column if not exists duration_le_500_count bigint not null default 0 check (duration_le_500_count >= 0),
  add column if not exists duration_le_1000_count bigint not null default 0 check (duration_le_1000_count >= 0),
  add column if not exists duration_le_3000_count bigint not null default 0 check (duration_le_3000_count >= 0),
  add column if not exists duration_le_10000_count bigint not null default 0 check (duration_le_10000_count >= 0),
  add column if not exists stage_duration_ms_sum jsonb not null default '{}'::jsonb
    check (jsonb_typeof(stage_duration_ms_sum) = 'object');

create or replace function public.instagram_record_observability_api_metric(
  p_organization_id uuid,
  p_route text,
  p_status_code integer,
  p_duration_ms integer,
  p_payload_bytes integer,
  p_stage_durations jsonb
) returns void
language plpgsql security definer set search_path = public as $$
declare
  bucket timestamptz := date_trunc('hour', timezone('utc', now()))
    + floor(extract(minute from timezone('utc', now())) / 5) * interval '5 minutes';
  normalized_stages jsonb := '{}'::jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Somente service_role pode registrar telemetria.';
  end if;
  if p_status_code not between 100 and 599
    or p_duration_ms not between 0 and 600000
    or p_payload_bytes not between 0 and 10485760
    or char_length(trim(coalesce(p_route, ''))) not between 1 and 180
    or jsonb_typeof(coalesce(p_stage_durations, '{}'::jsonb)) <> 'object' then
    raise exception using errcode = '22023', message = 'Métrica de API inválida.';
  end if;
  select coalesce(jsonb_object_agg(key, greatest(0, least(600000, value::integer))), '{}'::jsonb)
    into normalized_stages
  from jsonb_each_text(coalesce(p_stage_durations, '{}'::jsonb))
  where key ~ '^[a-z][a-z0-9_]{0,39}$' and value ~ '^[0-9]+$';

  insert into public.instagram_observability_api_rollups_5m (
    organization_id, bucket_at, route, status_code, request_count, error_count,
    duration_ms_sum, duration_ms_max, payload_bytes_sum, payload_bytes_max,
    duration_le_300_count, duration_le_500_count, duration_le_1000_count,
    duration_le_3000_count, duration_le_10000_count, stage_duration_ms_sum
  ) values (
    p_organization_id, bucket, trim(p_route), p_status_code, 1,
    case when p_status_code >= 500 then 1 else 0 end,
    p_duration_ms, p_duration_ms, p_payload_bytes, p_payload_bytes,
    case when p_duration_ms <= 300 then 1 else 0 end,
    case when p_duration_ms <= 500 then 1 else 0 end,
    case when p_duration_ms <= 1000 then 1 else 0 end,
    case when p_duration_ms <= 3000 then 1 else 0 end,
    case when p_duration_ms <= 10000 then 1 else 0 end,
    normalized_stages
  ) on conflict (organization_id, bucket_at, route, status_code) do update set
    request_count = instagram_observability_api_rollups_5m.request_count + 1,
    error_count = instagram_observability_api_rollups_5m.error_count + excluded.error_count,
    duration_ms_sum = instagram_observability_api_rollups_5m.duration_ms_sum + excluded.duration_ms_sum,
    duration_ms_max = greatest(instagram_observability_api_rollups_5m.duration_ms_max, excluded.duration_ms_max),
    payload_bytes_sum = instagram_observability_api_rollups_5m.payload_bytes_sum + excluded.payload_bytes_sum,
    payload_bytes_max = greatest(instagram_observability_api_rollups_5m.payload_bytes_max, excluded.payload_bytes_max),
    duration_le_300_count = instagram_observability_api_rollups_5m.duration_le_300_count + excluded.duration_le_300_count,
    duration_le_500_count = instagram_observability_api_rollups_5m.duration_le_500_count + excluded.duration_le_500_count,
    duration_le_1000_count = instagram_observability_api_rollups_5m.duration_le_1000_count + excluded.duration_le_1000_count,
    duration_le_3000_count = instagram_observability_api_rollups_5m.duration_le_3000_count + excluded.duration_le_3000_count,
    duration_le_10000_count = instagram_observability_api_rollups_5m.duration_le_10000_count + excluded.duration_le_10000_count,
    stage_duration_ms_sum = (
      select coalesce(jsonb_object_agg(stage_key,
        coalesce((instagram_observability_api_rollups_5m.stage_duration_ms_sum ->> stage_key)::bigint, 0)
        + coalesce((excluded.stage_duration_ms_sum ->> stage_key)::bigint, 0)), '{}'::jsonb)
      from (
        select key as stage_key from jsonb_each(instagram_observability_api_rollups_5m.stage_duration_ms_sum)
        union
        select key as stage_key from jsonb_each(excluded.stage_duration_ms_sum)
      ) stage_keys
    );
end;
$$;

revoke all on function public.instagram_record_observability_api_metric(uuid,text,integer,integer,integer,jsonb)
  from public, anon, authenticated;
grant execute on function public.instagram_record_observability_api_metric(uuid,text,integer,integer,integer,jsonb)
  to service_role;

create index if not exists publication_item_events_retention_time_idx
  on public.publication_item_events (created_at);
create index if not exists publication_worker_cycle_events_retention_time_idx
  on public.publication_worker_cycle_events (created_at);
create index if not exists zernio_sync_log_items_retention_time_idx
  on public.zernio_sync_log_items (created_at);
create index if not exists zernio_request_anomalies_retention_time_idx
  on public.zernio_publication_request_anomalies (occurred_at);
create index if not exists zernio_request_rollups_retention_time_idx
  on public.zernio_publication_request_rollups (window_started_at);

create or replace function public.maintain_instagram_legacy_log_retention_source(
  p_source text,
  p_retention_days integer default 14,
  p_batch_size integer default 500
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  cutoff timestamptz := timezone('utc', now()) - make_interval(days => greatest(14, least(coalesce(p_retention_days, 14), 14)));
  batch_size integer := greatest(100, least(coalesce(p_batch_size, 500), 5000));
  deleted_count bigint := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Apenas service_role mantém os logs legados.';
  end if;
  case p_source
    when 'publication_events' then
      with expired as (select ctid from public.publication_item_events where created_at < cutoff order by created_at limit batch_size)
      delete from public.publication_item_events target using expired where target.ctid = expired.ctid;
    when 'worker_cycles' then
      with expired as (select ctid from public.publication_worker_cycle_events where created_at < cutoff order by created_at limit batch_size)
      delete from public.publication_worker_cycle_events target using expired where target.ctid = expired.ctid;
    when 'sync_logs' then
      with expired as (select ctid from public.zernio_sync_log_items where created_at < cutoff order by created_at limit batch_size)
      delete from public.zernio_sync_log_items target using expired where target.ctid = expired.ctid;
    when 'request_anomalies' then
      with expired as (select ctid from public.zernio_publication_request_anomalies where occurred_at < cutoff order by occurred_at limit batch_size)
      delete from public.zernio_publication_request_anomalies target using expired where target.ctid = expired.ctid;
    when 'request_rollups' then
      with expired as (select ctid from public.zernio_publication_request_rollups where window_started_at < cutoff order by window_started_at limit batch_size)
      delete from public.zernio_publication_request_rollups target using expired where target.ctid = expired.ctid;
    else
      raise exception using errcode = '22023', message = 'Fonte legada inválida.';
  end case;
  get diagnostics deleted_count = row_count;
  return jsonb_build_object('source', p_source, 'cutoff', cutoff, 'deleted', deleted_count,
    'hasMore', deleted_count >= batch_size);
end;
$$;

revoke all on function public.maintain_instagram_legacy_log_retention_source(text,integer,integer)
  from public, anon, authenticated;
grant execute on function public.maintain_instagram_legacy_log_retention_source(text,integer,integer)
  to service_role;

create or replace function public.maintain_instagram_observability(
  p_retention_days integer default 14,
  p_days_ahead integer default 7,
  p_apply_legacy boolean default false
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  retention_days integer := greatest(14, least(coalesce(p_retention_days, 14), 14));
  days_ahead integer := greatest(3, least(coalesce(p_days_ahead, 7), 31));
  cutoff timestamptz := timezone('utc', now()) - make_interval(days => retention_days);
  partition_day date;
  partition_name text;
  boundary_partition text := 'instagram_observability_events_' || to_char(cutoff::date, 'YYYY_MM_DD');
  partition_row record;
  dropped_partitions integer := 0;
  deleted_boundary bigint := 0;
  boundary_batch_size integer := 5000;
  deleted_resolved bigint := 0;
  deleted_actions bigint := 0;
  deleted_rollups bigint := 0;
  deleted_worker_rollups bigint := 0;
  deleted_default bigint := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Apenas service_role mantém a observabilidade.';
  end if;
  if p_apply_legacy then
    raise exception using errcode = '22023', message = 'A retenção legada deve ser executada por fonte.';
  end if;

  for day_offset in 0..days_ahead loop
    partition_day := timezone('utc', now())::date + day_offset;
    partition_name := 'instagram_observability_events_' || to_char(partition_day, 'YYYY_MM_DD');
    if to_regclass('public.' || partition_name) is null then
      execute format(
        'create table public.%I partition of public.instagram_observability_events for values from (%L) to (%L)',
        partition_name, partition_day::timestamptz, (partition_day + 1)::timestamptz
      );
    end if;
  end loop;

  for partition_row in
    select child.relname as partition_name,
      to_date(substring(child.relname from '([0-9]{4}_[0-9]{2}_[0-9]{2})$'), 'YYYY_MM_DD') as partition_date
    from pg_inherits inheritance
    join pg_class parent on parent.oid = inheritance.inhparent
    join pg_class child on child.oid = inheritance.inhrelid
    join pg_namespace namespace on namespace.oid = child.relnamespace
    where parent.relname = 'instagram_observability_events'
      and namespace.nspname = 'public'
      and child.relname ~ '^instagram_observability_events_[0-9]{4}_[0-9]{2}_[0-9]{2}$'
  loop
    if partition_row.partition_date < cutoff::date then
      execute format('drop table public.%I', partition_row.partition_name);
      dropped_partitions := dropped_partitions + 1;
    end if;
  end loop;

  if to_regclass('public.' || boundary_partition) is not null then
    execute format(
      'with expired as (select ctid from public.%I where occurred_at < $1 order by occurred_at limit $2) '
      || 'delete from public.%I target using expired where target.ctid = expired.ctid',
      boundary_partition, boundary_partition
    ) using cutoff, boundary_batch_size;
    get diagnostics deleted_boundary = row_count;
  end if;
  delete from public.instagram_observability_events_default where occurred_at < cutoff;
  get diagnostics deleted_default = row_count;
  delete from public.instagram_observability_rollups_5m where window_started_at < cutoff;
  get diagnostics deleted_rollups = row_count;
  delete from public.instagram_worker_rollups_5m where window_started_at < cutoff;
  get diagnostics deleted_worker_rollups = row_count;
  delete from public.instagram_observability_incident_actions where created_at < cutoff;
  get diagnostics deleted_actions = row_count;
  delete from public.instagram_observability_incidents
  where treatment_state = 'resolved' and greatest(last_seen_at, coalesce(resolved_at, last_seen_at)) < cutoff;
  get diagnostics deleted_resolved = row_count;

  return jsonb_build_object(
    'cutoff', cutoff, 'droppedPartitions', dropped_partitions,
    'deletedBoundaryEvents', deleted_boundary,
    'hotHasMore', deleted_boundary >= boundary_batch_size,
    'deletedDefaultEvents', deleted_default, 'deletedResolvedIncidents', deleted_resolved,
    'deletedActions', deleted_actions, 'deletedRollups', deleted_rollups,
    'deletedWorkerRollups', deleted_worker_rollups, 'legacyApplied', false
  );
end;
$$;

-- A anomalia representa a causa operacional; perfil, conexão, request e status
-- exato continuam nos eventos/entidades e não podem fragmentar o incidente.
create or replace function public.project_zernio_request_anomaly_to_instagram_observability()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  target_domain public.instagram_observability_domain;
  target_severity public.instagram_observability_severity;
  target_treatment public.instagram_observability_treatment;
  target_profile uuid;
  target_code text;
  target_fingerprint text;
  terminal_disconnection boolean;
begin
  begin
    select item.profile_id into target_profile from public.publication_items item
    where item.id = new.publication_item_id and item.organization_id = new.organization_id;
    terminal_disconnection := lower(coalesce(new.provider_code, '')) in ('account_disconnected', 'auth_expired');
    target_domain := case when new.operation = 'disconnect_account' then 'connection'::public.instagram_observability_domain
      else 'publication'::public.instagram_observability_domain end;
    target_severity := case when new.outcome in ('timeout','network_error') then 'warning'::public.instagram_observability_severity
      else 'error'::public.instagram_observability_severity end;
    target_treatment := case when terminal_disconnection then 'contained'::public.instagram_observability_treatment
      when coalesce(new.attempt_count, 0) < 5 then 'auto_recovering'::public.instagram_observability_treatment
      else 'action_required'::public.instagram_observability_treatment end;
    target_code := case when terminal_disconnection then lower(new.provider_code)
      else 'zernio_' || new.operation || '_' || new.outcome end;
    target_fingerprint := public.instagram_observability_fingerprint(
      target_domain, 'provider_request', target_code, 'zernio', new.http_status, null
    );
    insert into public.instagram_observability_events (
      occurred_at, organization_id, domain, severity, treatment_state, stage,
      event_type, stable_code, fingerprint, provider, source_status, profile_id,
      connection_id, batch_id, item_id, http_status, provider_code, request_id,
      correlation_id, source_type, source_id, message, countermeasure, evidence
    ) values (
      new.occurred_at, new.organization_id, target_domain, target_severity,
      target_treatment, 'provider_request', 'zernio_request_' || new.outcome,
      target_code, target_fingerprint, 'zernio', new.outcome, target_profile,
      new.zernio_connection_id, new.batch_id, new.publication_item_id,
      new.http_status, new.provider_code, new.provider_request_id,
      new.correlation_id::text, 'zernio_publication_request_anomaly', new.id::text,
      coalesce(nullif(new.error_message, ''), 'A chamada Zernio terminou com ' || replace(new.outcome, '_', ' ') || '.'),
      jsonb_build_object('kind', case when terminal_disconnection then 'automatic_profile_removal'
        when target_treatment = 'auto_recovering' then 'automatic_retry' else 'manual_review' end,
        'attemptCount', new.attempt_count),
      jsonb_build_object('operation', new.operation, 'durationMs', new.duration_ms, 'timeoutMs', new.timeout_ms)
    ) on conflict (occurred_at, source_type, source_id) do nothing;
  exception when others then
    raise warning 'zernio request anomaly observability projection failed: %', sqlerrm;
  end;
  return new;
end;
$$;

revoke all on function public.project_zernio_request_anomaly_to_instagram_observability()
  from public, anon, authenticated;
grant execute on function public.project_zernio_request_anomaly_to_instagram_observability()
  to service_role;

notify pgrst, 'reload schema';
