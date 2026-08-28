-- Projeções das fontes autoritativas para a Central de observabilidade Instagram V2.
-- Nenhum fluxo de publicação muda de comportamento: os triggers apenas copiam
-- evidências sanitizadas e agregam telemetria operacional.

create or replace function public.project_publication_item_event_to_instagram_observability()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  item_row public.publication_items%rowtype;
  profile_provider text;
  origin_group uuid;
  resolved_severity public.instagram_observability_severity := 'info';
  resolved_treatment public.instagram_observability_treatment := 'resolved';
  resolved_code text;
  resolved_message text;
begin
  select item.* into item_row from public.publication_items item where item.id = new.publication_item_id;
  if not found then return new; end if;

  select profile.provider::text into profile_provider
  from public.instagram_profiles profile where profile.id = item_row.profile_id;
  select plan.origin_group_id into origin_group
  from public.bulk_publication_plans plan where plan.batch_id = item_row.batch_id
  order by plan.created_at desc limit 1;

  resolved_code := coalesce(nullif(new.error_code, ''), 'publication_' || new.event_type::text);
  resolved_message := coalesce(nullif(new.error_message, ''), case new.event_type::text
    when 'queued' then 'Publicação agendada e registrada na fila.'
    when 'processing_started' then 'Worker iniciou o processamento da publicação.'
    when 'processing_deferred' then 'Processamento adiado com nova tentativa programada.'
    when 'published' then 'Publicação confirmada pelo provedor.'
    when 'retry_requested' then 'Nova tentativa solicitada para a publicação.'
    when 'cancelled' then 'Publicação cancelada.'
    when 'ignored' then 'Publicação retirada da fila por uma contramedida.'
    when 'suspended' then 'Publicação suspensa por uma contramedida operacional.'
    else 'Falha durante o processamento da publicação.' end);

  if new.event_type::text = 'failed' then
    resolved_severity := case when coalesce(new.error_code, '') in (
      'publication_outcome_unknown', 'zernio_outcome_unknown', 'meta_outcome_unknown'
    ) then 'critical' else 'error' end;
    resolved_treatment := case when item_row.next_attempt_at is not null
      then 'auto_recovering' else 'action_required' end;
  elsif new.event_type::text in ('processing_deferred', 'retry_requested') then
    resolved_severity := 'warning'; resolved_treatment := 'auto_recovering';
  elsif new.event_type::text in ('ignored', 'suspended') then
    resolved_severity := 'warning'; resolved_treatment := 'contained';
  end if;

  insert into public.instagram_observability_events (
    occurred_at, organization_id, domain, severity, treatment_state, stage,
    event_type, stable_code, provider, source_status, publication_format,
    profile_id, source_group_id, batch_id, item_id, worker_name, post_id,
    correlation_id, source_type, source_id, message, countermeasure, evidence
  ) values (
    new.created_at, new.organization_id, 'publication', resolved_severity,
    resolved_treatment, case
      when new.event_type::text = 'queued' then 'scheduled'
      when new.event_type::text in ('processing_started', 'processing_deferred') then 'claimed'
      when new.event_type::text = 'published' then 'provider_confirmed'
      else 'publication_outcome' end,
    new.event_type::text, resolved_code, profile_provider, new.status::text,
    item_row.format::text, item_row.profile_id, origin_group, item_row.batch_id,
    item_row.id, new.actor_label, item_row.meta_media_id,
    nullif(new.metadata ->> 'correlation_id', ''), 'publication_item_event',
    new.id::text, resolved_message,
    jsonb_strip_nulls(jsonb_build_object(
      'kind', case
        when item_row.next_attempt_at is not null then 'automatic_retry'
        when new.event_type::text in ('ignored', 'suspended') then 'automatic_containment'
        else null end,
      'nextAttemptAt', item_row.next_attempt_at,
      'attemptCount', item_row.attempt_count
    )),
    jsonb_strip_nulls(jsonb_build_object(
      'previousStatus', new.previous_status, 'status', new.status,
      'executeAt', item_row.execute_at, 'publishedAt', item_row.published_at,
      'metadata', new.metadata
    ))
  ) on conflict (occurred_at, source_type, source_id) do nothing;

  if new.event_type::text in ('published', 'cancelled') then
    update public.instagram_observability_incident_entities entity
    set state = 'resolved', resolved_at = new.created_at,
        last_seen_at = greatest(entity.last_seen_at, new.created_at)
    where entity.entity_type = 'item' and entity.entity_id = item_row.id
      and entity.state <> 'resolved';
  end if;
  return new;
end;
$$;

create trigger publication_item_events_project_observability
after insert on public.publication_item_events
for each row execute function public.project_publication_item_event_to_instagram_observability();

create or replace function public.project_zernio_sync_log_to_instagram_observability()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  severity public.instagram_observability_severity;
  treatment public.instagram_observability_treatment;
begin
  severity := case when new.status::text = 'succeeded' then 'info'
    when new.status::text = 'conflict' then 'warning' else 'error' end;
  treatment := case when new.status::text = 'succeeded' then 'resolved'
    when new.status::text = 'conflict' then 'contained' else 'action_required' end;
  insert into public.instagram_observability_events (
    occurred_at, organization_id, domain, severity, treatment_state, stage,
    event_type, stable_code, provider, source_status, profile_id, connection_id,
    batch_id, source_type, source_id, message, countermeasure, evidence
  ) values (
    new.created_at, new.organization_id, 'connection', severity, treatment,
    'zernio_sync', 'sync_' || new.status::text,
    coalesce(nullif(new.error_code, ''), 'zernio_sync_' || new.status::text),
    'zernio', new.status::text, new.conflict_profile_id, new.zernio_connection_id,
    new.batch_id, 'zernio_sync_log_item', new.id::text,
    coalesce(nullif(new.error_message, ''), case when new.status::text = 'succeeded'
      then 'Sincronização Zernio concluída.' else 'Sincronização Zernio requer atenção.' end),
    case when new.status::text = 'conflict'
      then jsonb_build_object('kind', 'identity_conflict_contained') else '{}'::jsonb end,
    jsonb_build_object('syncedCount', new.synced_count, 'instagramIdentity', new.instagram_identity)
  ) on conflict (occurred_at, source_type, source_id) do nothing;
  return new;
end;
$$;

create trigger zernio_sync_log_items_project_observability
after insert on public.zernio_sync_log_items
for each row execute function public.project_zernio_sync_log_to_instagram_observability();

create or replace function public.project_zernio_disconnection_to_instagram_observability()
returns trigger language plpgsql security definer set search_path = public as $$
declare completed boolean := new.state = 'completed';
begin
  insert into public.instagram_observability_events (
    occurred_at, organization_id, domain, severity, treatment_state, stage,
    event_type, stable_code, provider, source_status, profile_id, connection_id,
    batch_id, item_id, http_status, request_id, source_type, source_id, message,
    countermeasure, evidence
  ) values (
    coalesce(new.updated_at, new.detected_at), new.organization_id, 'connection',
    case when completed then 'info' else 'error' end,
    case when completed then 'resolved' else 'auto_recovering' end,
    'zernio_disconnection_recovery', 'disconnection_' || new.state,
    new.error_code, 'zernio', new.state, new.profile_id, new.zernio_connection_id,
    new.source_batch_id, new.source_item_id, new.remote_http_status,
    new.remote_request_id, 'zernio_disconnection_incident',
    new.id::text || ':' || new.state || ':' || extract(epoch from coalesce(new.updated_at, new.detected_at))::text,
    case when completed then 'Recuperação de desconexão Zernio concluída.' else new.error_message end,
    jsonb_build_object(
      'kind', case when completed then 'automatic_recovery_completed' else 'automatic_recovery' end,
      'state', new.state
    ),
    jsonb_strip_nulls(jsonb_build_object(
      'signal', new.signal, 'remoteResult', new.remote_result,
      'ignoredItemCount', new.ignored_item_count,
      'interruptedPlanCount', new.interrupted_plan_count
    ))
  ) on conflict (occurred_at, source_type, source_id) do nothing;
  return new;
end;
$$;

create trigger zernio_disconnection_incidents_project_observability
after insert or update of state, remote_http_status, remote_result
on public.zernio_profile_disconnection_incidents
for each row execute function public.project_zernio_disconnection_to_instagram_observability();

create or replace function public.aggregate_publication_worker_cycle_observability()
returns trigger language plpgsql security definer set search_path = public as $$
declare bucket timestamptz;
begin
  if new.phase = 'started' then return new; end if;
  bucket := date_trunc('hour', new.created_at)
    + make_interval(mins => (extract(minute from new.created_at)::integer / 5) * 5);
  insert into public.instagram_worker_rollups_5m (
    window_started_at, worker_kind, completed_cycles, failed_cycles,
    claimed_count, succeeded_count, failed_count, duration_sum_ms, duration_max_ms
  ) values (
    bucket, new.worker_kind,
    case when new.phase = 'completed' then 1 else 0 end,
    case when new.phase = 'failed' then 1 else 0 end,
    coalesce((new.metadata ->> 'claimed_count')::bigint, 0),
    coalesce((new.metadata ->> 'published_count')::bigint, 0),
    coalesce((new.metadata ->> 'failed_count')::bigint, 0),
    coalesce(new.duration_ms, 0), new.duration_ms
  ) on conflict (window_started_at, worker_kind) do update set
    completed_cycles = public.instagram_worker_rollups_5m.completed_cycles + excluded.completed_cycles,
    failed_cycles = public.instagram_worker_rollups_5m.failed_cycles + excluded.failed_cycles,
    claimed_count = public.instagram_worker_rollups_5m.claimed_count + excluded.claimed_count,
    succeeded_count = public.instagram_worker_rollups_5m.succeeded_count + excluded.succeeded_count,
    failed_count = public.instagram_worker_rollups_5m.failed_count + excluded.failed_count,
    duration_sum_ms = public.instagram_worker_rollups_5m.duration_sum_ms + excluded.duration_sum_ms,
    duration_max_ms = greatest(public.instagram_worker_rollups_5m.duration_max_ms, excluded.duration_max_ms),
    updated_at = timezone('utc', now());
  return new;
exception when invalid_text_representation then
  return new;
end;
$$;

create trigger publication_worker_cycles_aggregate_observability
after insert on public.publication_worker_cycle_events
for each row execute function public.aggregate_publication_worker_cycle_observability();

revoke all on function public.project_publication_item_event_to_instagram_observability() from public, anon, authenticated;
revoke all on function public.project_zernio_sync_log_to_instagram_observability() from public, anon, authenticated;
revoke all on function public.project_zernio_disconnection_to_instagram_observability() from public, anon, authenticated;
revoke all on function public.aggregate_publication_worker_cycle_observability() from public, anon, authenticated;
grant execute on function public.project_publication_item_event_to_instagram_observability(),
  public.project_zernio_sync_log_to_instagram_observability(),
  public.project_zernio_disconnection_to_instagram_observability(),
  public.aggregate_publication_worker_cycle_observability() to service_role;

notify pgrst, 'reload schema';
