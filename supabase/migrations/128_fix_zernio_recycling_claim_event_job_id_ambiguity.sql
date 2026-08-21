-- Corrige a ambiguidade entre a coluna job_id do ledger e a coluna de saída
-- homônima da RPC de claim. A falha 42702 revertia integralmente o claim,
-- portanto nenhum job era entregue, mas os deferred continuavam duráveis.

create or replace function public.claim_zernio_profile_recycling_jobs(
  p_worker_id text, p_limit integer default 10, p_lease_seconds integer default 180
)
returns table (
  job_id uuid, incident_id uuid, organization_id uuid,
  zernio_connection_id uuid, zernio_account_id text, attempt_count integer
)
language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao worker.';
  end if;
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120
    or p_limit not between 1 and 100
    or p_lease_seconds not between 30 and 900 then
    raise exception using errcode = '22023', message = 'Parâmetros de claim inválidos.';
  end if;

  update public.zernio_profile_recycling_jobs job set
    next_attempt_at = timezone('utc', now()) + interval '5 minutes',
    deferred_reason = case
      when control.automatic_duplicate_removal_enabled = false then 'automatic_removal_frozen'
      else 'active_publication'
    end
  from public.zernio_profile_disconnection_incidents incident
  left join public.zernio_sync_operational_controls control
    on control.organization_id = incident.organization_id
  where job.incident_id = incident.id
    and job.status = 'deferred'
    and job.next_attempt_at <= timezone('utc', now())
    and incident.signal = 'duplicate_identity_auto_removed'
    and (
      control.automatic_duplicate_removal_enabled = false
      or exists (
        select 1 from public.publication_items item
        where item.organization_id = incident.organization_id
          and item.profile_id = incident.retained_profile_id
          and item.status in ('preparing', 'publishing')
      )
    );

  return query
  with candidates as (
    select job.id
    from public.zernio_profile_recycling_jobs job
    join public.zernio_profile_disconnection_incidents incident
      on incident.id = job.incident_id
      and incident.organization_id = job.organization_id
    left join public.zernio_sync_operational_controls control
      on control.organization_id = incident.organization_id
    where job.status in ('pending', 'deferred', 'remote_removal_pending', 'retry_pending', 'processing')
      and job.attempt_count < job.max_attempts
      and job.next_attempt_at <= timezone('utc', now())
      and (job.lease_until is null or job.lease_until <= timezone('utc', now()))
      and (
        incident.signal <> 'duplicate_identity_auto_removed'
        or (
          coalesce(control.automatic_duplicate_removal_enabled, true)
          and not exists (
            select 1 from public.publication_items item
            where item.organization_id = incident.organization_id
              and item.profile_id = incident.retained_profile_id
              and item.status in ('preparing', 'publishing')
          )
        )
      )
    order by job.next_attempt_at, job.created_at, job.id
    for update of job skip locked
    limit p_limit
  ), claimed as (
    update public.zernio_profile_recycling_jobs job set
      status = 'processing',
      claimed_by = trim(p_worker_id),
      lease_until = timezone('utc', now()) + make_interval(secs => p_lease_seconds),
      attempt_count = job.attempt_count + 1,
      deferred_reason = null
    from candidates
    where job.id = candidates.id
    returning job.id, job.incident_id, job.organization_id, job.attempt_count
  ), activated as (
    update public.zernio_profile_disconnection_incidents incident set
      state = 'remote_removal_pending',
      defer_reason = null
    from claimed
    where incident.id = claimed.incident_id
    returning incident.id
  ), events as (
    insert into public.zernio_profile_recycling_job_events (
      organization_id, job_id, incident_id, event_type,
      previous_status, status, attempt_count
    )
    select claimed.organization_id, claimed.id, claimed.incident_id,
      'claimed', null, 'processing', claimed.attempt_count
    from claimed
    returning public.zernio_profile_recycling_job_events.job_id
  )
  select claimed.id, claimed.incident_id, claimed.organization_id,
    incident.zernio_connection_id, incident.zernio_account_id,
    claimed.attempt_count
  from claimed
  join public.zernio_profile_disconnection_incidents incident
    on incident.id = claimed.incident_id
  join activated on activated.id = incident.id;
end;
$$;

revoke all on function public.claim_zernio_profile_recycling_jobs(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_zernio_profile_recycling_jobs(text, integer, integer)
  to service_role;

notify pgrst, 'reload schema';
