-- Corrige a contenção/remoção de contas Zernio desconectadas e impede que
-- observabilidade best-effort reverta operações autoritativas.

create or replace function public.project_zernio_disconnection_to_instagram_observability()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  completed boolean := new.state = 'completed';
  target_severity public.instagram_observability_severity;
  target_treatment public.instagram_observability_treatment;
begin
  target_severity := case when completed
    then 'info'::public.instagram_observability_severity
    else 'error'::public.instagram_observability_severity end;
  target_treatment := case when completed
    then 'resolved'::public.instagram_observability_treatment
    else 'auto_recovering'::public.instagram_observability_treatment end;
  begin
    insert into public.instagram_observability_events (
      occurred_at, organization_id, domain, severity, treatment_state, stage,
      event_type, stable_code, provider, source_status, profile_id, connection_id,
      batch_id, item_id, http_status, request_id, source_type, source_id, message,
      countermeasure, evidence
    ) values (
      coalesce(new.updated_at, new.detected_at), new.organization_id, 'connection',
      target_severity, target_treatment,
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
  exception when others then
    raise warning 'zernio disconnection observability projection failed: %', sqlerrm;
  end;
  return new;
end;
$$;

create or replace function public.contain_zernio_disconnected_profile(
  p_organization_id uuid,
  p_profile_id uuid,
  p_incident_id uuid,
  p_actor_label text default 'system: zernio-profile-containment'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  ignored_count integer := 0;
  plan_count integer := 0;
  affected_batch uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao service_role.';
  end if;

  update public.instagram_profiles set
    status = 'offline',
    last_error_code = 'zernio_account_disconnected',
    last_error_message = 'Conta Zernio desconectada; perfil contido e encaminhado para remoção automática.'
  where id = p_profile_id and organization_id = p_organization_id and provider = 'zernio' and deleted_at is null;

  with targets as (
    select item.id, item.status as previous_status
    from public.publication_items item
    where item.organization_id = p_organization_id and item.profile_id = p_profile_id
      and item.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended')
    for update
  ), ignored as (
    update public.publication_items item set
      status = 'ignored', claimed_by = null, lease_until = null,
      next_attempt_at = null, attempt_count = 0,
      last_error_code = 'zernio_account_disconnected',
      last_error_message = 'Conta Zernio desconectada; publicação ignorada.'
    from targets where item.id = targets.id
    returning item.id, targets.previous_status
  ), logged as (
    insert into public.publication_item_events (
      organization_id, publication_item_id, event_type, previous_status,
      status, actor_label, error_code, error_message, metadata
    )
    select p_organization_id, ignored.id, 'cancelled', ignored.previous_status,
      'ignored', left(coalesce(nullif(trim(p_actor_label), ''), 'system: zernio-profile-containment'), 180),
      'zernio_account_disconnected', 'Conta Zernio desconectada; publicação ignorada.',
      jsonb_build_object('incident_id', p_incident_id, 'containment', 'terminal_disconnection')
    from ignored returning publication_item_id
  ) select count(*)::integer into ignored_count from logged;

  delete from public.publication_profile_daily_reservations reservation
  using public.publication_items item
  where reservation.publication_item_id = item.id
    and item.organization_id = p_organization_id and item.profile_id = p_profile_id;
  delete from public.publication_dispatch_rate_reservations reservation
  using public.publication_items item
  where reservation.publication_item_id = item.id
    and item.organization_id = p_organization_id and item.profile_id = p_profile_id;

  update public.bulk_publication_generation_chunks chunk set
    status = 'cancelled', completed_at = coalesce(completed_at, timezone('utc', now())),
    claimed_by = null, lease_until = null
  where chunk.organization_id = p_organization_id and chunk.profile_id = p_profile_id
    and chunk.status in ('queued', 'processing', 'failed', 'paused');
  update public.bulk_publication_profile_horizons horizon set
    status = 'cancelled', released_at = coalesce(released_at, timezone('utc', now()))
  where horizon.organization_id = p_organization_id and horizon.profile_id = p_profile_id
    and horizon.status = 'active';
  with updated_plans as (
    update public.bulk_publication_plan_profiles plan_profile set
      status = 'cancelled', suspended_at = coalesce(suspended_at, timezone('utc', now())),
      suspension_reason = 'Conta Zernio desconectada; perfil removido automaticamente.'
    where plan_profile.organization_id = p_organization_id and plan_profile.profile_id = p_profile_id
      and plan_profile.status in ('queued', 'generating', 'suspended')
    returning plan_profile.id
  ) select count(*)::integer into plan_count from updated_plans;

  for affected_batch in
    select distinct item.batch_id from public.publication_items item
    where item.organization_id = p_organization_id and item.profile_id = p_profile_id
  loop
    perform public.sync_publication_batch_status(affected_batch);
  end loop;

  return jsonb_build_object('contained', true, 'ignoredItemCount', ignored_count, 'interruptedPlanCount', plan_count);
end;
$$;

create or replace function public.schedule_zernio_sync_profile_disconnection(
  p_organization_id uuid,
  p_profile_id uuid,
  p_signal text default 'auth_expired',
  p_error_code text default 'zernio_account_disconnected',
  p_error_message text default 'A Zernio informou que a conta foi desconectada.',
  p_actor_label text default 'system: zernio-sync-worker'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  profile_row public.instagram_profiles%rowtype;
  connection_label text;
  incident_row public.zernio_profile_disconnection_incidents%rowtype;
  normalized_signal text;
  containment jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao service_role.';
  end if;
  if p_signal not in ('account_disconnected', 'auth_expired') then
    raise exception using errcode = '22023', message = 'Sinal de desconexão Zernio inválido.';
  end if;
  normalized_signal := p_signal;

  select profile.* into profile_row from public.instagram_profiles profile
  where profile.id = p_profile_id and profile.organization_id = p_organization_id
    and profile.provider = 'zernio' and profile.deleted_at is null
  for update;
  if not found or nullif(trim(coalesce(profile_row.zernio_account_id, '')), '') is null then
    return jsonb_build_object('scheduled', false, 'reason', 'profile_not_found_or_already_deleted');
  end if;
  select label into connection_label from public.zernio_connections connection
  where connection.id = profile_row.zernio_connection_id and connection.organization_id = profile_row.organization_id;

  insert into public.zernio_profile_disconnection_incidents (
    organization_id, profile_id, zernio_connection_id, zernio_account_id,
    username_snapshot, connection_label_snapshot, signal, source,
    error_code, error_message, detected_at, state
  ) values (
    profile_row.organization_id, profile_row.id, profile_row.zernio_connection_id,
    profile_row.zernio_account_id, profile_row.username, connection_label,
    normalized_signal, 'zernio_sync_worker',
    left(coalesce(nullif(trim(p_error_code), ''), normalized_signal), 120),
    left(coalesce(nullif(trim(p_error_message), ''), 'A Zernio informou que a conta foi desconectada.'), 1200),
    timezone('utc', now()), 'remote_removal_pending'
  ) on conflict (organization_id, profile_id) do update set
    signal = excluded.signal, error_code = excluded.error_code,
    error_message = excluded.error_message, updated_at = timezone('utc', now()),
    last_observed_at = timezone('utc', now()),
    occurrence_count = public.zernio_profile_disconnection_incidents.occurrence_count + 1,
    state = case when public.zernio_profile_disconnection_incidents.state in ('completed', 'dead_letter')
      then 'remote_removal_pending' else public.zernio_profile_disconnection_incidents.state end
  returning * into incident_row;

  insert into public.zernio_profile_recycling_jobs (organization_id, incident_id, status)
  values (profile_row.organization_id, incident_row.id, 'pending')
  on conflict (incident_id) do update set
    status = case when public.zernio_profile_recycling_jobs.status = 'completed'
      then public.zernio_profile_recycling_jobs.status else 'pending' end,
    claimed_by = case when public.zernio_profile_recycling_jobs.status = 'completed'
      then public.zernio_profile_recycling_jobs.claimed_by else null end,
    lease_until = case when public.zernio_profile_recycling_jobs.status = 'completed'
      then public.zernio_profile_recycling_jobs.lease_until else null end,
    next_attempt_at = case when public.zernio_profile_recycling_jobs.status = 'completed'
      then public.zernio_profile_recycling_jobs.next_attempt_at else timezone('utc', now()) end;

  containment := public.contain_zernio_disconnected_profile(
    profile_row.organization_id, profile_row.id, incident_row.id, p_actor_label
  );
  return jsonb_build_object(
    'scheduled', true, 'incidentId', incident_row.id, 'profileId', profile_row.id,
    'username', profile_row.username, 'containment', containment
  );
end;
$$;

create or replace function public.schedule_zernio_profile_disconnection(
  p_item_id uuid,
  p_worker_id text,
  p_signal text,
  p_error_code text,
  p_error_message text,
  p_revert_claim_attempt boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  item_row public.publication_items%rowtype;
  scheduled jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao worker.';
  end if;
  if p_signal not in ('account_disconnected', 'auth_expired') then
    raise exception using errcode = '22023', message = 'Sinal de desconexão Zernio inválido.';
  end if;
  select item.* into item_row from public.publication_items item
  where item.id = p_item_id and item.claimed_by = trim(p_worker_id)
    and item.lease_until > timezone('utc', now()) and item.status in ('preparing', 'publishing')
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Item não está sob lease deste worker.';
  end if;

  scheduled := public.schedule_zernio_sync_profile_disconnection(
    item_row.organization_id, item_row.profile_id, p_signal, p_error_code,
    p_error_message, trim(p_worker_id)
  );
  if coalesce((scheduled ->> 'scheduled')::boolean, false) then
    update public.zernio_profile_disconnection_incidents set
      source = 'publication_worker', source_item_id = item_row.id,
      source_batch_id = item_row.batch_id, updated_at = timezone('utc', now())
    where id = (scheduled ->> 'incidentId')::uuid;
  end if;
  return scheduled || jsonb_build_object('attemptReverted', p_revert_claim_attempt);
end;
$$;

create or replace function public.project_zernio_request_anomaly_to_instagram_observability()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  target_domain public.instagram_observability_domain;
  target_severity public.instagram_observability_severity;
  target_treatment public.instagram_observability_treatment;
  target_profile uuid;
  target_fingerprint text;
  terminal_disconnection boolean;
begin
  select item.profile_id into target_profile from public.publication_items item
  where item.id = new.publication_item_id and item.organization_id = new.organization_id;
  terminal_disconnection := lower(coalesce(new.provider_code, '')) in ('account_disconnected', 'auth_expired');
  target_domain := case when new.operation = 'disconnect_account' then 'connection' else 'publication' end;
  target_severity := case when new.outcome in ('timeout','network_error') then 'warning' else 'error' end;
  target_treatment := case
    when terminal_disconnection then 'contained'::public.instagram_observability_treatment
    when coalesce(new.attempt_count, 0) < 5 then 'auto_recovering'::public.instagram_observability_treatment
    else 'action_required'::public.instagram_observability_treatment end;
  target_fingerprint := encode(extensions.digest(concat_ws('|',
    'v2', new.organization_id::text, target_domain::text, 'provider_request',
    'zernio_' || new.operation || '_' || new.outcome, 'zernio',
    coalesce(target_profile::text, 'none'), coalesce(new.zernio_connection_id::text, 'none'),
    lower(coalesce(new.provider_code, 'none')), coalesce(new.http_status::text, 'none')
  ), 'sha256'), 'hex');
  begin
    insert into public.instagram_observability_events (
      occurred_at, organization_id, domain, severity, treatment_state, stage,
      event_type, stable_code, fingerprint, provider, source_status, profile_id,
      connection_id, batch_id, item_id, http_status, provider_code, request_id,
      correlation_id, source_type, source_id, message, countermeasure, evidence
    ) values (
      new.occurred_at, new.organization_id, target_domain, target_severity,
      target_treatment, 'provider_request', 'zernio_request_' || new.outcome,
      'zernio_' || new.operation || '_' || new.outcome, target_fingerprint,
      'zernio', new.outcome, target_profile, new.zernio_connection_id,
      new.batch_id, new.publication_item_id, new.http_status, new.provider_code,
      new.provider_request_id, new.correlation_id::text,
      'zernio_publication_request_anomaly', new.id::text,
      coalesce(nullif(new.error_message, ''), 'A chamada Zernio terminou com ' || replace(new.outcome, '_', ' ') || '.'),
      jsonb_build_object(
        'kind', case when terminal_disconnection then 'automatic_profile_removal'
          when target_treatment = 'auto_recovering' then 'automatic_retry' else 'manual_review' end,
        'attemptCount', new.attempt_count
      ),
      jsonb_build_object('operation', new.operation, 'durationMs', new.duration_ms, 'timeoutMs', new.timeout_ms)
    ) on conflict (occurred_at, source_type, source_id) do nothing;
  exception when others then
    raise warning 'zernio request anomaly observability projection failed: %', sqlerrm;
  end;
  return new;
end;
$$;

create or replace function public.recover_confirmed_zernio_terminal_disconnections(
  p_since timestamptz default '2026-08-26T18:00:00Z'::timestamptz
) returns table (
  organization_id uuid, profile_id uuid, username text, signal text,
  signal_count bigint, scheduled boolean, incident_id uuid
) language plpgsql security definer set search_path = public as $$
declare
  candidate record;
  result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao service_role.';
  end if;
  for candidate in
    with terminal_signals as (
      select anomaly.organization_id, anomaly.publication_item_id,
        anomaly.provider_code, anomaly.error_message, anomaly.id::text as source_id
      from public.zernio_publication_request_anomalies anomaly
      where anomaly.occurred_at >= p_since
        and lower(coalesce(anomaly.provider_code, '')) in ('account_disconnected', 'auth_expired')
      union
      select event.organization_id, event.item_id,
        event.provider_code, event.message, event.source_id
      from public.instagram_observability_events event
      where event.occurred_at >= p_since
        and event.source_type = 'zernio_publication_request_anomaly'
        and lower(coalesce(event.provider_code, '')) in ('account_disconnected', 'auth_expired')
    )
    select profile.organization_id, profile.id as profile_id, profile.username,
      case when bool_or(lower(signal.provider_code) = 'auth_expired') then 'auth_expired'
        else 'account_disconnected' end as signal,
      count(distinct signal.source_id)::bigint as signal_count,
      max(signal.error_message) as error_message
    from terminal_signals signal
    join public.publication_items item on item.id = signal.publication_item_id
      and item.organization_id = signal.organization_id
    join public.instagram_profiles profile on profile.id = item.profile_id
      and profile.organization_id = signal.organization_id
    where profile.provider = 'zernio' and profile.deleted_at is null
      and nullif(trim(coalesce(profile.zernio_account_id, '')), '') is not null
    group by profile.organization_id, profile.id, profile.username
    order by profile.organization_id, profile.id
  loop
    result := public.schedule_zernio_sync_profile_disconnection(
      candidate.organization_id, candidate.profile_id, candidate.signal,
      candidate.signal, candidate.error_message, 'system: zernio-terminal-recovery'
    );
    organization_id := candidate.organization_id;
    profile_id := candidate.profile_id;
    username := candidate.username;
    signal := candidate.signal;
    signal_count := candidate.signal_count;
    scheduled := coalesce((result ->> 'scheduled')::boolean, false);
    incident_id := nullif(result ->> 'incidentId', '')::uuid;
    return next;
  end loop;
end;
$$;

create or replace function public.rebuild_zernio_request_observability()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  affected_incidents uuid[];
  deleted_events integer := 0;
  inserted_events integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao service_role.';
  end if;
  drop table if exists pg_temp.zernio_observability_rebuild_source;
  create temporary table zernio_observability_rebuild_source on commit drop as
  select event.occurred_at, event.id, event.organization_id, event.domain,
    event.severity, event.treatment_state, event.stage, event.event_type,
    event.stable_code, event.provider, event.source_status,
    event.publication_format, event.profile_id, event.connection_id,
    event.source_group_id, event.batch_id, event.item_id, event.job_id,
    event.attempt_id, event.worker_kind, event.worker_name, event.worker_id,
    event.http_status, event.provider_code, event.request_id, event.post_id,
    event.correlation_id, event.source_type, event.source_id, event.message,
    event.countermeasure, event.evidence, event.incident_id
  from public.instagram_observability_events event
  where event.source_type = 'zernio_publication_request_anomaly';

  select array_agg(distinct event.incident_id) filter (where event.incident_id is not null)
  into affected_incidents from public.instagram_observability_events event
  where event.source_type = 'zernio_publication_request_anomaly';
  delete from public.instagram_observability_events event
  where event.source_type = 'zernio_publication_request_anomaly';
  get diagnostics deleted_events = row_count;
  if affected_incidents is not null then
    delete from public.instagram_observability_incidents incident
    where incident.id = any(affected_incidents)
      and not exists (select 1 from public.instagram_observability_events event where event.incident_id = incident.id);
    update public.instagram_observability_incidents incident set
      occurrence_count = aggregate.occurrence_count,
      first_seen_at = aggregate.first_seen_at,
      last_seen_at = aggregate.last_seen_at,
      title = aggregate.title
    from (
      select event.incident_id, count(*)::bigint as occurrence_count,
        min(event.occurred_at) as first_seen_at, max(event.occurred_at) as last_seen_at,
        (array_agg(event.message order by event.occurred_at desc, event.id desc))[1] as title
      from public.instagram_observability_events event
      where event.incident_id = any(affected_incidents)
      group by event.incident_id
    ) aggregate where incident.id = aggregate.incident_id;
  end if;

  insert into public.instagram_observability_events (
    occurred_at, organization_id, domain, severity, treatment_state, stage,
    event_type, stable_code, fingerprint, provider, source_status, profile_id,
    connection_id, batch_id, item_id, http_status, provider_code, request_id,
    correlation_id, source_type, source_id, message, countermeasure, evidence
  )
  select source.occurred_at, source.organization_id, source.domain,
    source.severity,
    case when lower(coalesce(source.provider_code, '')) in ('account_disconnected','auth_expired')
      then 'contained'::public.instagram_observability_treatment
      else source.treatment_state end,
    source.stage, source.event_type, source.stable_code,
    encode(extensions.digest(concat_ws('|',
      'v2', source.organization_id::text, source.domain::text,
      source.stage, source.stable_code, coalesce(source.provider, 'zernio'),
      coalesce(item.profile_id::text, 'none'),
      coalesce(source.connection_id::text, 'none'),
      lower(coalesce(source.provider_code, 'none')), coalesce(source.http_status::text, 'none')
    ), 'sha256'), 'hex'),
    source.provider, source.source_status, item.profile_id, source.connection_id,
    source.batch_id, source.item_id, source.http_status,
    source.provider_code, source.request_id, source.correlation_id,
    source.source_type, source.source_id, source.message,
    jsonb_build_object(
      'kind', case when lower(coalesce(source.provider_code, '')) in ('account_disconnected','auth_expired')
        then 'automatic_profile_removal' else coalesce(source.countermeasure ->> 'kind', 'manual_review') end,
      'attemptCount', source.countermeasure -> 'attemptCount'
    ) || (source.countermeasure - 'kind' - 'attemptCount'),
    source.evidence
  from pg_temp.zernio_observability_rebuild_source source
  left join public.publication_items item on item.id = source.item_id
    and item.organization_id = source.organization_id
  on conflict (occurred_at, source_type, source_id) do nothing;
  get diagnostics inserted_events = row_count;
  return jsonb_build_object('deletedEvents', deleted_events, 'insertedEvents', inserted_events);
end;
$$;

revoke all on function public.contain_zernio_disconnected_profile(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.schedule_zernio_sync_profile_disconnection(uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.schedule_zernio_profile_disconnection(uuid, text, text, text, text, boolean) from public, anon, authenticated;
revoke all on function public.recover_confirmed_zernio_terminal_disconnections(timestamptz) from public, anon, authenticated;
revoke all on function public.rebuild_zernio_request_observability() from public, anon, authenticated;
grant execute on function public.contain_zernio_disconnected_profile(uuid, uuid, uuid, text) to service_role;
grant execute on function public.schedule_zernio_sync_profile_disconnection(uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.schedule_zernio_profile_disconnection(uuid, text, text, text, text, boolean) to service_role;
grant execute on function public.recover_confirmed_zernio_terminal_disconnections(timestamptz) to service_role;
grant execute on function public.rebuild_zernio_request_observability() to service_role;

notify pgrst, 'reload schema';
