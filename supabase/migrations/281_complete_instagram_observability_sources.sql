-- Completa as fontes operacionais previstas para a Central Instagram.
-- Estes triggers são best-effort: uma falha de observabilidade nunca bloqueia
-- a transação autoritativa que está sendo observada.

alter table public.instagram_observability_view_preferences
  drop constraint if exists instagram_observability_view_preferences_scope_key_check;
alter table public.instagram_observability_view_preferences
  add constraint instagram_observability_view_preferences_scope_key_check
  check (scope_key in (
    'account', 'scheduling', 'publication', 'worker', 'connection',
    'analytics', 'media', 'analytics_media', 'activity'
  ));

create or replace function public.instagram_set_observability_view_preference(
  p_organization_id uuid,
  p_scope_key text,
  p_action text
) returns public.instagram_observability_view_preferences
language plpgsql security definer set search_path = public as $$
declare preference public.instagram_observability_view_preferences;
begin
  if not public.is_organization_member(p_organization_id) then
    raise exception using errcode = '42501', message = 'Permissão insuficiente.';
  end if;
  if p_scope_key not in (
    'account','scheduling','publication','worker','connection',
    'analytics','media','analytics_media','activity'
  ) or p_action not in ('clear','undo') then
    raise exception using errcode = '22023', message = 'Preferência de logs Instagram inválida.';
  end if;
  insert into public.instagram_observability_view_preferences (
    organization_id, actor_user_id, scope_key, cleared_at
  ) values (
    p_organization_id, auth.uid(), p_scope_key,
    case when p_action = 'clear' then timezone('utc', now()) else null end
  ) on conflict (organization_id, actor_user_id, scope_key) do update set
    cleared_at = excluded.cleared_at, updated_at = timezone('utc', now())
  returning * into preference;
  return preference;
end;
$$;

create or replace function public.project_instagram_status_source_to_observability()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  payload jsonb := to_jsonb(new);
  previous_payload jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  current_status text := lower(coalesce(payload ->> 'status', 'unknown'));
  previous_status text := lower(coalesce(previous_payload ->> 'status', ''));
  target_domain public.instagram_observability_domain := tg_argv[0]::public.instagram_observability_domain;
  target_stage text := tg_argv[1];
  target_source_type text := tg_argv[2];
  target_code text := tg_argv[3];
  target_label text := tg_argv[4];
  entity_kind text := coalesce(tg_argv[5], 'job');
  target_severity public.instagram_observability_severity;
  target_treatment public.instagram_observability_treatment;
  target_message text;
  target_time timestamptz;
  target_provider text;
  target_profile uuid;
  target_connection uuid;
  target_job uuid;
  target_attempt uuid;
  source_identity text;
begin
  if tg_op = 'UPDATE' and current_status = previous_status then return new; end if;

  target_time := coalesce(
    nullif(payload ->> 'finished_at', '')::timestamptz,
    nullif(payload ->> 'completed_at', '')::timestamptz,
    nullif(payload ->> 'processed_at', '')::timestamptz,
    nullif(payload ->> 'failed_at', '')::timestamptz,
    nullif(payload ->> 'synced_at', '')::timestamptz,
    nullif(payload ->> 'updated_at', '')::timestamptz,
    nullif(payload ->> 'created_at', '')::timestamptz,
    timezone('utc', now())
  );
  target_provider := nullif(coalesce(payload ->> 'provider', tg_argv[6], ''), '');
  target_profile := nullif(payload ->> 'profile_id', '')::uuid;
  target_connection := nullif(coalesce(payload ->> 'zernio_connection_id', payload ->> 'connection_id', ''), '')::uuid;
  if entity_kind = 'job' then target_job := (payload ->> 'id')::uuid; end if;
  if entity_kind = 'attempt' then target_attempt := (payload ->> 'id')::uuid; end if;
  if entity_kind = 'connection' then target_connection := (payload ->> 'id')::uuid; end if;

  if current_status in ('failed','offline','reauthorization_required') then
    target_severity := 'error'; target_treatment := 'action_required';
  elsif current_status in ('completed_with_errors','empty','no_data') then
    target_severity := 'warning'; target_treatment := 'action_required';
  elsif current_status in ('remote_removal_pending','retrying','paused') then
    target_severity := 'warning'; target_treatment := 'auto_recovering';
  elsif current_status in ('cancelled','deleted','skipped') then
    target_severity := 'info'; target_treatment := 'resolved';
  elsif current_status in ('completed','synced','ready','online') and previous_status in (
    'failed','offline','reauthorization_required','completed_with_errors','empty',
    'no_data','remote_removal_pending','retrying','paused'
  ) then
    target_severity := 'warning'; target_treatment := 'resolved';
  else
    target_severity := 'info'; target_treatment := 'resolved';
  end if;

  target_message := case
    when target_treatment = 'action_required' then target_label || ' exige atenção: ' || replace(current_status, '_', ' ') || '.'
    when target_treatment = 'auto_recovering' then target_label || ' está sob recuperação: ' || replace(current_status, '_', ' ') || '.'
    when target_severity = 'warning' and target_treatment = 'resolved' then target_label || ' se recuperou: ' || replace(current_status, '_', ' ') || '.'
    else target_label || ': ' || replace(current_status, '_', ' ') || '.' end;
  if nullif(payload ->> 'last_error_message', '') is not null and target_treatment <> 'resolved' then
    target_message := left(payload ->> 'last_error_message', 1000);
  elsif nullif(payload ->> 'processing_error', '') is not null and target_treatment <> 'resolved' then
    target_message := left(payload ->> 'processing_error', 1000);
  end if;
  source_identity := payload ->> 'id' || ':' || current_status || ':' || extract(epoch from target_time)::text;

  begin
    insert into public.instagram_observability_events (
      occurred_at, organization_id, domain, severity, treatment_state, stage,
      event_type, stable_code, provider, source_status, profile_id, connection_id,
      job_id, attempt_id, worker_kind, worker_name, source_type, source_id,
      message, countermeasure, evidence
    ) values (
      target_time, (payload ->> 'organization_id')::uuid, target_domain,
      target_severity, target_treatment, target_stage,
      target_source_type || '_' || current_status, target_code, target_provider,
      current_status, target_profile, target_connection, target_job, target_attempt,
      nullif(tg_argv[7], ''), nullif(payload ->> 'claimed_by', ''),
      target_source_type, source_identity, target_message,
      jsonb_strip_nulls(jsonb_build_object(
        'kind', case
          when target_treatment = 'auto_recovering' then 'automatic_retry'
          when current_status = 'paused' then 'automatic_containment'
          else null end,
        'nextAttemptAt', payload ->> 'next_attempt_at',
        'leaseUntil', payload ->> 'lease_until',
        'attemptCount', payload ->> 'attempt_count'
      )),
      jsonb_strip_nulls(jsonb_build_object(
        'previousStatus', nullif(previous_status, ''),
        'status', current_status,
        'totalCount', payload ->> 'total_count',
        'processedCount', payload ->> 'processed_count',
        'failedCount', coalesce(payload ->> 'failed_count', payload ->> 'failed_items'),
        'succeededCount', coalesce(payload ->> 'synced_count', payload ->> 'generated_items'),
        'trigger', payload ->> 'trigger',
        'action', payload ->> 'action',
        'assetKind', payload ->> 'kind'
      ))
    ) on conflict (occurred_at, source_type, source_id) do nothing;
  exception when others then
    raise warning 'instagram observability projection failed for %.%: %', tg_table_schema, tg_table_name, sqlerrm;
  end;
  return new;
end;
$$;

create or replace function public.project_instagram_profile_to_observability()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  current_state text;
  previous_state text;
  target_severity public.instagram_observability_severity;
  target_treatment public.instagram_observability_treatment;
  target_code text;
  target_message text;
begin
  current_state := case when new.deleted_at is not null then 'removed' else new.status::text end;
  previous_state := case when tg_op = 'UPDATE' then case when old.deleted_at is not null then 'removed' else old.status::text end else '' end;
  if tg_op = 'UPDATE' and current_state = previous_state
    and coalesce(new.last_error_code, '') = coalesce(old.last_error_code, '')
    and coalesce(new.zernio_connection_id::text, '') = coalesce(old.zernio_connection_id::text, '') then
    return new;
  end if;
  if current_state in ('offline','reauthorization_required') then
    target_severity := 'error'; target_treatment := 'action_required'; target_code := 'profile_unavailable';
    target_message := coalesce(nullif(new.last_error_message, ''), 'Perfil indisponível para operações do Instagram.');
  elsif current_state = 'online' and previous_state in ('offline','reauthorization_required') then
    target_severity := 'warning'; target_treatment := 'resolved'; target_code := 'profile_unavailable';
    target_message := 'Perfil voltou a ficar disponível.';
  elsif current_state = 'removed' then
    target_severity := 'warning'; target_treatment := 'contained'; target_code := 'profile_removed';
    target_message := coalesce(nullif(new.last_error_message, ''), 'Perfil removido do escopo operacional.');
  else
    target_severity := 'info'; target_treatment := 'resolved'; target_code := 'profile_state_changed';
    target_message := 'Estado do perfil atualizado para ' || replace(current_state, '_', ' ') || '.';
  end if;
  begin
    insert into public.instagram_observability_events (
      occurred_at, organization_id, domain, severity, treatment_state, stage,
      event_type, stable_code, provider, source_status, profile_id, connection_id,
      provider_code, source_type, source_id, message, countermeasure, evidence
    ) values (
      coalesce(new.updated_at, timezone('utc', now())), new.organization_id, 'account',
      target_severity, target_treatment, 'profile_health', 'profile_' || current_state,
      target_code, new.provider::text, current_state, new.id, new.zernio_connection_id,
      new.last_error_code, 'instagram_profile',
      new.id::text || ':' || current_state || ':' || extract(epoch from coalesce(new.updated_at, timezone('utc', now())))::text,
      target_message,
      case when current_state = 'removed' then jsonb_build_object('kind','profile_contained') else '{}'::jsonb end,
      jsonb_build_object('previousStatus', nullif(previous_state,''), 'status', current_state)
    ) on conflict (occurred_at, source_type, source_id) do nothing;
  exception when others then
    raise warning 'instagram profile observability projection failed: %', sqlerrm;
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
begin
  target_domain := case when new.operation = 'disconnect_account' then 'connection' else 'publication' end;
  target_severity := case when new.outcome in ('timeout','network_error') then 'warning' else 'error' end;
  target_treatment := case when coalesce(new.attempt_count, 0) < 5 then 'auto_recovering' else 'action_required' end;
  begin
    insert into public.instagram_observability_events (
      occurred_at, organization_id, domain, severity, treatment_state, stage,
      event_type, stable_code, provider, source_status, connection_id, batch_id,
      item_id, http_status, provider_code, request_id, correlation_id,
      source_type, source_id, message, countermeasure, evidence
    ) values (
      new.occurred_at, new.organization_id, target_domain, target_severity,
      target_treatment, 'provider_request', 'zernio_request_' || new.outcome,
      'zernio_' || new.operation || '_' || new.outcome, 'zernio', new.outcome,
      new.zernio_connection_id, new.batch_id, new.publication_item_id,
      new.http_status, new.provider_code, new.provider_request_id,
      new.correlation_id::text, 'zernio_publication_request_anomaly', new.id::text,
      coalesce(nullif(new.error_message, ''), 'A chamada Zernio terminou com ' || replace(new.outcome, '_', ' ') || '.'),
      jsonb_build_object('kind', case when target_treatment = 'auto_recovering' then 'automatic_retry' else 'manual_review' end, 'attemptCount', new.attempt_count),
      jsonb_build_object('operation', new.operation, 'durationMs', new.duration_ms, 'timeoutMs', new.timeout_ms)
    ) on conflict (occurred_at, source_type, source_id) do nothing;
  exception when others then
    raise warning 'zernio request anomaly observability projection failed: %', sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists instagram_profiles_project_observability on public.instagram_profiles;
create trigger instagram_profiles_project_observability
after insert or update of status, deleted_at, last_error_code, zernio_connection_id
on public.instagram_profiles for each row execute function public.project_instagram_profile_to_observability();

drop trigger if exists zernio_connections_project_observability on public.zernio_connections;
create trigger zernio_connections_project_observability
after insert or update of status on public.zernio_connections for each row execute function
public.project_instagram_status_source_to_observability('connection','connection_health','zernio_connection','connection_unavailable','Conexão Zernio','connection','zernio','zernio_sync');

drop trigger if exists zernio_connection_attempts_project_observability on public.zernio_connection_attempts;
create trigger zernio_connection_attempts_project_observability
after insert or update of status on public.zernio_connection_attempts for each row execute function
public.project_instagram_status_source_to_observability('connection','account_addition','zernio_connection_attempt','zernio_account_addition','Adição de conta Zernio','attempt','zernio','zernio_sync');

drop trigger if exists publication_generation_jobs_project_observability on public.publication_generation_jobs;
create trigger publication_generation_jobs_project_observability
after insert or update of status on public.publication_generation_jobs for each row execute function
public.project_instagram_status_source_to_observability('scheduling','generation_job','publication_generation_job','publication_generation_job','Geração de publicações','job','','publication_planner');

drop trigger if exists media_deletion_jobs_project_observability on public.media_deletion_jobs;
create trigger media_deletion_jobs_project_observability
after insert or update of status on public.media_deletion_jobs for each row execute function
public.project_instagram_status_source_to_observability('media','deletion_job','media_deletion_job','media_deletion_job','Limpeza de mídia','job','','media_deletion');

drop trigger if exists media_group_assignment_jobs_project_observability on public.media_group_assignment_jobs;
create trigger media_group_assignment_jobs_project_observability
after insert or update of status on public.media_group_assignment_jobs for each row execute function
public.project_instagram_status_source_to_observability('media','group_assignment_job','media_group_assignment_job','media_group_assignment_job','Organização de mídia','job','','media_group_assignment');

drop trigger if exists profile_analytics_refresh_jobs_project_observability on public.profile_analytics_refresh_jobs;
create trigger profile_analytics_refresh_jobs_project_observability
after insert or update of status on public.profile_analytics_refresh_jobs for each row execute function
public.project_instagram_status_source_to_observability('analytics','analytics_refresh_job','profile_analytics_refresh_job','profile_analytics_refresh_job','Atualização de analytics','job','','profile_analytics');

drop trigger if exists zernio_profile_recycling_jobs_project_observability on public.zernio_profile_recycling_jobs;
create trigger zernio_profile_recycling_jobs_project_observability
after insert or update of status on public.zernio_profile_recycling_jobs for each row execute function
public.project_instagram_status_source_to_observability('connection','profile_recycling','zernio_profile_recycling_job','zernio_profile_recycling','Reciclagem de perfil Zernio','job','zernio','zernio_sync');

drop trigger if exists media_assets_project_observability on public.media_assets;
create trigger media_assets_project_observability
after insert or update of status on public.media_assets for each row execute function
public.project_instagram_status_source_to_observability('media','asset_processing','media_asset','media_asset_processing','Processamento de mídia','asset','','media_deletion');

drop trigger if exists zernio_request_anomalies_project_observability on public.zernio_publication_request_anomalies;
create trigger zernio_request_anomalies_project_observability
after insert on public.zernio_publication_request_anomalies for each row execute function
public.project_zernio_request_anomaly_to_instagram_observability();

revoke all on function public.project_instagram_status_source_to_observability() from public, anon, authenticated;
revoke all on function public.project_instagram_profile_to_observability() from public, anon, authenticated;
revoke all on function public.project_zernio_request_anomaly_to_instagram_observability() from public, anon, authenticated;

notify pgrst, 'reload schema';
