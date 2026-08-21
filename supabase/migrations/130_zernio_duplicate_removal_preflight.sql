-- Exige revalidação explícita das ocorrências canônica e excedente antes de
-- liberar um job de duplicidade congelado para o consumidor destrutivo.

alter table public.zernio_profile_disconnection_incidents
  add column if not exists removal_preflight_at timestamptz,
  add column if not exists removal_preflight_snapshot_at timestamptz,
  add column if not exists removal_preflight_by text
    check (removal_preflight_by is null or char_length(removal_preflight_by) <= 160);

create or replace function public.approve_zernio_duplicate_removal_preflight(
  p_incident_id uuid,
  p_snapshot_at timestamptz,
  p_retained_connection_id uuid,
  p_retained_account_id text,
  p_removed_connection_id uuid,
  p_removed_account_id text,
  p_approved_by text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  incident_row public.zernio_profile_disconnection_incidents%rowtype;
  job_row public.zernio_profile_recycling_jobs%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao worker administrativo.';
  end if;
  if p_snapshot_at is null
    or p_snapshot_at < timezone('utc', now()) - interval '10 minutes'
    or char_length(trim(coalesce(p_approved_by, ''))) not between 3 and 160
    or nullif(trim(p_retained_account_id), '') is null
    or nullif(trim(p_removed_account_id), '') is null then
    raise exception using errcode = '22023', message = 'Preflight inválido ou vencido.';
  end if;

  select incident.* into incident_row
  from public.zernio_profile_disconnection_incidents incident
  where incident.id = p_incident_id
    and incident.signal = 'duplicate_identity_auto_removed'
  for update;
  if not found then raise exception 'Incidente de duplicidade não encontrado.'; end if;
  if incident_row.state not in ('deferred', 'retry_scheduled', 'remote_removal_pending') then
    raise exception 'Incidente não está elegível para preflight.';
  end if;
  if incident_row.retained_zernio_connection_id is distinct from p_retained_connection_id
    or incident_row.retained_zernio_account_id is distinct from trim(p_retained_account_id)
    or incident_row.removed_zernio_connection_id is distinct from p_removed_connection_id
    or incident_row.removed_zernio_account_id is distinct from trim(p_removed_account_id) then
    raise exception 'O snapshot revalidado diverge da decisão canônica persistida.';
  end if;
  if exists (
    select 1 from public.publication_items item
    where item.organization_id = incident_row.organization_id
      and item.profile_id = incident_row.retained_profile_id
      and item.status in ('preparing', 'publishing')
  ) then
    raise exception 'Publicação ativa bloqueia a remoção excedente.';
  end if;

  select job.* into job_row
  from public.zernio_profile_recycling_jobs job
  where job.incident_id = incident_row.id
  for update;
  if not found then raise exception 'Job durável do incidente não encontrado.'; end if;
  if job_row.status = 'processing' and job_row.lease_until > timezone('utc', now()) then
    raise exception 'Job já está sob lease de outro worker.';
  end if;

  update public.zernio_profile_disconnection_incidents set
    state = 'remote_removal_pending',
    defer_reason = null,
    removal_preflight_at = timezone('utc', now()),
    removal_preflight_snapshot_at = p_snapshot_at,
    removal_preflight_by = left(trim(p_approved_by), 160)
  where id = incident_row.id;

  update public.zernio_profile_recycling_jobs set
    status = 'pending',
    next_attempt_at = timezone('utc', now()),
    claimed_by = null,
    lease_until = null,
    deferred_reason = null
  where id = job_row.id;

  insert into public.zernio_profile_recycling_job_events (
    organization_id, job_id, incident_id, event_type,
    previous_status, status, attempt_count, metadata
  ) values (
    incident_row.organization_id, job_row.id, incident_row.id,
    'removal_preflight_approved', job_row.status, 'pending', job_row.attempt_count,
    jsonb_build_object(
      'snapshotAt', p_snapshot_at,
      'retainedConnectionId', p_retained_connection_id,
      'retainedAccountId', trim(p_retained_account_id),
      'removedConnectionId', p_removed_connection_id,
      'removedAccountId', trim(p_removed_account_id),
      'approvedBy', left(trim(p_approved_by), 160)
    )
  );

  return jsonb_build_object(
    'approved', true,
    'incidentId', incident_row.id,
    'jobId', job_row.id,
    'snapshotAt', p_snapshot_at
  );
end;
$$;

revoke all on function public.approve_zernio_duplicate_removal_preflight(
  uuid, timestamptz, uuid, text, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.approve_zernio_duplicate_removal_preflight(
  uuid, timestamptz, uuid, text, uuid, text, text
) to service_role;

notify pgrst, 'reload schema';
