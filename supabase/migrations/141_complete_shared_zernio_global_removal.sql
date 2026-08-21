-- Finalização exclusiva para o caso em que a Zernio expõe o mesmo account ID
-- em duas chaves. O DELETE é global; após confirmação remota, o perfil canônico
-- recebe soft delete e sua operação pendente é encerrada de forma auditável.

create or replace function public.complete_zernio_shared_account_global_removal(
  p_incident_id uuid,
  p_job_id uuid,
  p_worker_id text,
  p_remote_outcome text,
  p_http_status integer,
  p_request_id text,
  p_requested_by uuid
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  incident_row public.zernio_profile_disconnection_incidents%rowtype;
  job_row public.zernio_profile_recycling_jobs%rowtype;
  profile_row public.instagram_profiles%rowtype;
  ignored_count integer := 0;
  plan_count integer := 0;
  affected_batch uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao endpoint administrativo.';
  end if;
  if p_remote_outcome not in ('remote_deleted', 'already_disconnected_404') then
    raise exception using errcode = '22023', message = 'Resultado remoto inválido para remoção global.';
  end if;

  select incident.* into incident_row
  from public.zernio_profile_disconnection_incidents incident
  where incident.id = p_incident_id
    and incident.signal = 'duplicate_identity_auto_removed'
  for update;
  if not found then raise exception 'Incidente de duplicidade não encontrado.'; end if;
  if incident_row.retained_profile_id is null
    or incident_row.retained_zernio_account_id is null
    or incident_row.retained_zernio_account_id is distinct from incident_row.removed_zernio_account_id then
    raise exception 'Incidente não representa um account ID global compartilhado.';
  end if;

  select job.* into job_row
  from public.zernio_profile_recycling_jobs job
  where job.id = p_job_id
    and job.incident_id = incident_row.id
    and job.claimed_by = trim(p_worker_id)
    and job.lease_until > timezone('utc', now())
    and job.status = 'processing'
  for update;
  if not found then raise exception 'Job não está sob lease deste executor administrativo.'; end if;

  select profile.* into profile_row
  from public.instagram_profiles profile
  where profile.id = incident_row.retained_profile_id
    and profile.organization_id = incident_row.organization_id
    and profile.provider = 'zernio'
    and profile.zernio_connection_id = incident_row.retained_zernio_connection_id
    and profile.zernio_account_id = incident_row.retained_zernio_account_id
  for update;
  if not found then raise exception 'Perfil local canônico divergiu do preflight.'; end if;

  if profile_row.deleted_at is null then
    if exists (
      select 1 from public.publication_items item
      where item.organization_id = incident_row.organization_id
        and item.profile_id = profile_row.id
        and item.status in ('preparing', 'publishing')
    ) then
      raise exception 'Publicação ativa bloqueia o soft delete do perfil.';
    end if;

    with targets as (
      select item.id, item.status as previous_status
      from public.publication_items item
      where item.organization_id = incident_row.organization_id
        and item.profile_id = profile_row.id
        and item.status in ('waiting', 'ready', 'failed', 'suspended')
      for update
    ), ignored as (
      update public.publication_items item set
        status = 'ignored', claimed_by = null, lease_until = null,
        next_attempt_at = null, attempt_count = 0,
        last_error_code = 'zernio_shared_account_globally_removed',
        last_error_message = 'Account ID removido globalmente da Zernio; perfil local removido por soft delete.'
      from targets where item.id = targets.id
      returning item.id, targets.previous_status
    ), logged as (
      insert into public.publication_item_events (
        organization_id, publication_item_id, event_type, previous_status,
        status, actor_label, error_code, error_message, metadata
      )
      select incident_row.organization_id, ignored.id, 'cancelled', ignored.previous_status,
        'ignored', 'admin: zernio-shared-global-removal',
        'zernio_shared_account_globally_removed',
        'Account ID removido globalmente da Zernio; perfil local removido por soft delete.',
        jsonb_build_object('incident_id', incident_row.id, 'requested_by', p_requested_by)
      from ignored returning publication_item_id
    ) select count(*)::integer into ignored_count from logged;

    delete from public.publication_profile_daily_reservations reservation
    using public.publication_items item
    where reservation.publication_item_id = item.id
      and item.organization_id = incident_row.organization_id
      and item.profile_id = profile_row.id
      and item.status = 'ignored';
    delete from public.publication_dispatch_rate_reservations reservation
    using public.publication_items item
    where reservation.publication_item_id = item.id
      and item.organization_id = incident_row.organization_id
      and item.profile_id = profile_row.id
      and item.status = 'ignored';
    update public.bulk_publication_generation_chunks chunk set
      status = 'cancelled', completed_at = coalesce(completed_at, timezone('utc', now())),
      claimed_by = null, lease_until = null
    where chunk.organization_id = incident_row.organization_id
      and chunk.profile_id = profile_row.id
      and chunk.status in ('queued', 'processing', 'failed', 'paused');
    update public.bulk_publication_profile_horizons horizon set
      status = 'cancelled', released_at = coalesce(released_at, timezone('utc', now()))
    where horizon.organization_id = incident_row.organization_id
      and horizon.profile_id = profile_row.id
      and horizon.status = 'active';
    with updated_plans as (
      update public.bulk_publication_plan_profiles plan_profile set
        status = 'cancelled', suspended_at = coalesce(suspended_at, timezone('utc', now())),
        suspension_reason = 'Account ID removido globalmente da Zernio; perfil local removido por soft delete.'
      where plan_profile.organization_id = incident_row.organization_id
        and plan_profile.profile_id = profile_row.id
        and plan_profile.status in ('queued', 'generating', 'suspended')
      returning plan_profile.id
    ) select count(*)::integer into plan_count from updated_plans;
    delete from public.profile_group_members
    where organization_id = incident_row.organization_id and profile_id = profile_row.id;
    update public.instagram_profiles set
      deleted_at = timezone('utc', now()), status = 'offline',
      last_error_code = 'zernio_shared_account_globally_removed',
      last_error_message = 'Account ID removido das duas chaves Zernio por ação administrativa.'
    where id = profile_row.id and organization_id = profile_row.organization_id;
  end if;

  for affected_batch in
    select distinct item.batch_id from public.publication_items item
    where item.organization_id = incident_row.organization_id and item.profile_id = profile_row.id
  loop
    perform public.sync_publication_batch_status(affected_batch);
  end loop;

  update public.zernio_profile_disconnection_incidents set
    state = 'completed', remote_http_status = p_http_status,
    remote_request_id = left(nullif(trim(p_request_id), ''), 160),
    remote_result = p_remote_outcome,
    remote_completed_at = timezone('utc', now()), finalized_at = timezone('utc', now()),
    ignored_item_count = ignored_count, interrupted_plan_count = plan_count,
    defer_reason = null,
    error_code = 'zernio_shared_account_globally_removed',
    error_message = left(format(
      'Account ID global de @%s removido das duas chaves por solicitação administrativa; perfil local %s removido por soft delete.',
      incident_row.normalized_identity, profile_row.id
    ), 1200)
  where id = incident_row.id;

  update public.zernio_profile_recycling_jobs set
    status = 'completed', claimed_by = null, lease_until = null,
    completed_at = timezone('utc', now()), last_http_status = p_http_status,
    last_request_id = left(nullif(trim(p_request_id), ''), 160),
    last_error_code = null, last_error_message = null,
    last_outcome = p_remote_outcome, deferred_reason = null
  where id = job_row.id;

  insert into public.zernio_profile_recycling_job_events (
    organization_id, job_id, incident_id, event_type,
    previous_status, status, attempt_count, metadata
  ) values (
    incident_row.organization_id, job_row.id, incident_row.id,
    'completed', 'processing', 'completed', job_row.attempt_count,
    jsonb_build_object(
      'outcome', p_remote_outcome, 'httpStatus', p_http_status,
      'mode', 'shared_account_global_removal', 'profileId', profile_row.id,
      'softDeleted', true, 'requestedBy', p_requested_by
    )
  );

  return jsonb_build_object(
    'completed', true, 'incidentId', incident_row.id, 'profileId', profile_row.id,
    'softDeleted', true, 'ignoredItemCount', ignored_count,
    'interruptedPlanCount', plan_count, 'outcome', p_remote_outcome
  );
end;
$$;

revoke all on function public.complete_zernio_shared_account_global_removal(
  uuid, uuid, text, text, integer, text, uuid
) from public, anon, authenticated;
grant execute on function public.complete_zernio_shared_account_global_removal(
  uuid, uuid, text, text, integer, text, uuid
) to service_role;

notify pgrst, 'reload schema';
