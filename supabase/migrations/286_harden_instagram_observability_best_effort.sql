-- Impede que projeções de observabilidade Instagram revertam operações
-- autoritativas. Esta migration não altera nem reenfileira publicações.

create or replace function public.project_publication_item_event_to_instagram_observability()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  item_row public.publication_items%rowtype;
  profile_provider text;
  origin_group uuid;
  resolved_domain public.instagram_observability_domain := 'publication'::public.instagram_observability_domain;
  resolved_severity public.instagram_observability_severity := 'info'::public.instagram_observability_severity;
  resolved_treatment public.instagram_observability_treatment := 'resolved'::public.instagram_observability_treatment;
  resolved_code text;
  resolved_message text;
begin
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
      ) then 'critical'::public.instagram_observability_severity
        else 'error'::public.instagram_observability_severity end;
      resolved_treatment := case when item_row.next_attempt_at is not null
        then 'auto_recovering'::public.instagram_observability_treatment
        else 'action_required'::public.instagram_observability_treatment end;
    elsif new.event_type::text in ('processing_deferred', 'retry_requested') then
      resolved_severity := 'warning'::public.instagram_observability_severity;
      resolved_treatment := 'auto_recovering'::public.instagram_observability_treatment;
    elsif new.event_type::text in ('ignored', 'suspended') then
      resolved_severity := 'warning'::public.instagram_observability_severity;
      resolved_treatment := 'contained'::public.instagram_observability_treatment;
    end if;

    insert into public.instagram_observability_events (
      occurred_at, organization_id, domain, severity, treatment_state, stage,
      event_type, stable_code, provider, source_status, publication_format,
      profile_id, source_group_id, batch_id, item_id, worker_name, post_id,
      correlation_id, source_type, source_id, message, countermeasure, evidence
    ) values (
      new.created_at, new.organization_id, resolved_domain, resolved_severity,
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
  exception when others then
    raise warning 'publication event observability projection failed: %', sqlerrm;
  end;
  return new;
end;
$$;

create or replace function public.project_zernio_sync_log_to_instagram_observability()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  target_domain public.instagram_observability_domain := 'connection'::public.instagram_observability_domain;
  target_severity public.instagram_observability_severity;
  target_treatment public.instagram_observability_treatment;
begin
  begin
    target_severity := case when new.status::text = 'succeeded'
      then 'info'::public.instagram_observability_severity
      when new.status::text = 'conflict'
      then 'warning'::public.instagram_observability_severity
      else 'error'::public.instagram_observability_severity end;
    target_treatment := case when new.status::text = 'succeeded'
      then 'resolved'::public.instagram_observability_treatment
      when new.status::text = 'conflict'
      then 'contained'::public.instagram_observability_treatment
      else 'action_required'::public.instagram_observability_treatment end;
    insert into public.instagram_observability_events (
      occurred_at, organization_id, domain, severity, treatment_state, stage,
      event_type, stable_code, provider, source_status, profile_id, connection_id,
      batch_id, source_type, source_id, message, countermeasure, evidence
    ) values (
      new.created_at, new.organization_id, target_domain, target_severity, target_treatment,
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
  exception when others then
    raise warning 'zernio sync observability projection failed: %', sqlerrm;
  end;
  return new;
end;
$$;

create or replace function public.project_zernio_disconnection_to_instagram_observability()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  completed boolean := new.state = 'completed';
  target_domain public.instagram_observability_domain := 'connection'::public.instagram_observability_domain;
  target_severity public.instagram_observability_severity;
  target_treatment public.instagram_observability_treatment;
begin
  begin
    target_severity := case when completed
      then 'info'::public.instagram_observability_severity
      else 'error'::public.instagram_observability_severity end;
    target_treatment := case when completed
      then 'resolved'::public.instagram_observability_treatment
      else 'auto_recovering'::public.instagram_observability_treatment end;
    insert into public.instagram_observability_events (
      occurred_at, organization_id, domain, severity, treatment_state, stage,
      event_type, stable_code, provider, source_status, profile_id, connection_id,
      batch_id, item_id, http_status, request_id, source_type, source_id, message,
      countermeasure, evidence
    ) values (
      coalesce(new.updated_at, new.detected_at), new.organization_id, target_domain,
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
  begin
    select item.profile_id into target_profile from public.publication_items item
    where item.id = new.publication_item_id and item.organization_id = new.organization_id;
    terminal_disconnection := lower(coalesce(new.provider_code, '')) in ('account_disconnected', 'auth_expired');
    target_domain := case when new.operation = 'disconnect_account'
      then 'connection'::public.instagram_observability_domain
      else 'publication'::public.instagram_observability_domain end;
    target_severity := case when new.outcome in ('timeout','network_error')
      then 'warning'::public.instagram_observability_severity
      else 'error'::public.instagram_observability_severity end;
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

revoke all on function public.project_publication_item_event_to_instagram_observability() from public, anon, authenticated;
revoke all on function public.project_zernio_sync_log_to_instagram_observability() from public, anon, authenticated;
revoke all on function public.project_zernio_disconnection_to_instagram_observability() from public, anon, authenticated;
revoke all on function public.project_zernio_request_anomaly_to_instagram_observability() from public, anon, authenticated;
grant execute on function public.project_publication_item_event_to_instagram_observability(),
  public.project_zernio_sync_log_to_instagram_observability(),
  public.project_zernio_disconnection_to_instagram_observability(),
  public.project_zernio_request_anomaly_to_instagram_observability() to service_role;

notify pgrst, 'reload schema';
