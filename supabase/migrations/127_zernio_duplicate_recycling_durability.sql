-- Fase 4A: torna adiamento, reincidência, retry e dead-letter duráveis.
-- O congelamento continua impedindo claim e DELETE, mas a duplicidade observada
-- passa a gerar incidente/job deferred para não depender de uma nova sincronia.

alter table public.zernio_profile_disconnection_incidents
  drop constraint if exists zernio_profile_disconnection_incidents_state_check;

alter table public.zernio_profile_disconnection_incidents
  add constraint zernio_profile_disconnection_incidents_state_check
  check (state in (
    'deferred', 'remote_removal_pending', 'retry_scheduled',
    'dead_letter', 'remote_deleted', 'already_disconnected_404', 'completed'
  ));

alter table public.zernio_profile_disconnection_incidents
  add column retained_profile_id uuid references public.instagram_profiles(id) on delete set null,
  add column defer_reason text check (defer_reason is null or char_length(defer_reason) <= 500),
  add column occurrence_count integer not null default 1 check (occurrence_count >= 1),
  add column last_observed_at timestamptz not null default timezone('utc', now()),
  add column reopened_at timestamptz;

alter table public.zernio_profile_recycling_jobs
  drop constraint if exists zernio_profile_recycling_jobs_status_check;

alter table public.zernio_profile_recycling_jobs
  add constraint zernio_profile_recycling_jobs_status_check
  check (status in (
    'pending', 'deferred', 'processing', 'remote_removal_pending',
    'retry_pending', 'dead_letter', 'completed'
  ));

alter table public.zernio_profile_recycling_jobs
  add column max_attempts integer not null default 6 check (max_attempts between 1 and 20),
  add column deferred_reason text check (deferred_reason is null or char_length(deferred_reason) <= 500),
  add column last_outcome text check (last_outcome is null or last_outcome in (
    'remote_deleted', 'already_disconnected_404', 'retryable_error', 'terminal_error'
  )),
  add column dead_letter_at timestamptz,
  add column reopened_count integer not null default 0 check (reopened_count >= 0);

drop index if exists public.zernio_recycling_jobs_claim_idx;
create index zernio_recycling_jobs_claim_idx
  on public.zernio_profile_recycling_jobs(status, next_attempt_at, lease_until, created_at)
  where status in ('pending', 'deferred', 'processing', 'remote_removal_pending', 'retry_pending');

create table public.zernio_profile_recycling_job_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  job_id uuid not null references public.zernio_profile_recycling_jobs(id) on delete cascade,
  incident_id uuid not null references public.zernio_profile_disconnection_incidents(id) on delete cascade,
  event_type text not null check (event_type in (
    'scheduled', 'deferred', 'claimed', 'retry_scheduled',
    'dead_lettered', 'reopened', 'completed'
  )),
  previous_status text,
  status text not null,
  attempt_count integer not null default 0,
  reason text check (reason is null or char_length(reason) <= 1200),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default timezone('utc', now())
);

create index zernio_profile_recycling_job_events_job_created_idx
  on public.zernio_profile_recycling_job_events(job_id, created_at desc);
create index zernio_profile_recycling_job_events_org_created_idx
  on public.zernio_profile_recycling_job_events(organization_id, created_at desc);

alter table public.zernio_profile_recycling_job_events enable row level security;
create policy zernio_profile_recycling_job_events_select_operator
  on public.zernio_profile_recycling_job_events for select to authenticated
  using (public.has_organization_role(organization_id, array['admin', 'operator']::public.organization_role[]));
revoke all on public.zernio_profile_recycling_job_events from public, anon, authenticated;
grant select on public.zernio_profile_recycling_job_events to authenticated;
grant all on public.zernio_profile_recycling_job_events to service_role;

create or replace function public.schedule_zernio_duplicate_identity_disconnection(
  p_organization_id uuid,
  p_zernio_connection_id uuid,
  p_zernio_account_id text,
  p_username text,
  p_retained_profile_id uuid
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  identity_value text := lower(nullif(trim(regexp_replace(p_username, '^@', '')), ''));
  connection_row public.zernio_connections%rowtype;
  retained_profile public.instagram_profiles%rowtype;
  incident_row public.zernio_profile_disconnection_incidents%rowtype;
  control_row public.zernio_sync_operational_controls%rowtype;
  job_row public.zernio_profile_recycling_jobs%rowtype;
  previous_job_status text;
  block_reason text;
  desired_incident_state text;
  desired_job_status text;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao worker.';
  end if;
  if identity_value is null or nullif(trim(p_zernio_account_id), '') is null then
    raise exception using errcode = '22023', message = 'Identidade ou accountId Zernio inválido.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(identity_value, 0));

  select * into connection_row
  from public.zernio_connections
  where id = p_zernio_connection_id
    and organization_id = p_organization_id
    and deleted_at is null
  for update;
  if not found then raise exception 'Conexão Zernio ativa não encontrada.'; end if;

  select * into retained_profile
  from public.instagram_profiles
  where id = p_retained_profile_id
    and provider = 'zernio'
    and deleted_at is null
  for update;
  if not found then raise exception 'Perfil canônico não encontrado.'; end if;
  if retained_profile.organization_id <> p_organization_id then
    raise exception 'Conflito entre organizações requer aprovação explícita; remoção automática bloqueada.';
  end if;
  if lower(trim(regexp_replace(retained_profile.username, '^@', ''))) <> identity_value then
    raise exception 'O perfil canônico não corresponde à identidade informada.';
  end if;
  if retained_profile.zernio_connection_id = p_zernio_connection_id
    and retained_profile.zernio_account_id = trim(p_zernio_account_id) then
    raise exception 'A conta excedente não pode ser o próprio perfil canônico.';
  end if;

  select * into control_row
  from public.zernio_sync_operational_controls
  where organization_id = p_organization_id;

  if found and not control_row.automatic_duplicate_removal_enabled then
    block_reason := 'automatic_removal_frozen';
  elsif exists (
    select 1
    from public.publication_items item
    where item.organization_id = p_organization_id
      and item.profile_id = retained_profile.id
      and item.status in ('preparing', 'publishing')
  ) then
    block_reason := 'active_publication';
  end if;

  desired_incident_state := case when block_reason is null then 'remote_removal_pending' else 'deferred' end;
  desired_job_status := case when block_reason is null then 'pending' else 'deferred' end;

  insert into public.zernio_profile_disconnection_incidents (
    organization_id, profile_id, retained_profile_id, zernio_connection_id,
    zernio_account_id, username_snapshot, connection_label_snapshot,
    signal, source, error_code, error_message, state, defer_reason,
    occurrence_count, last_observed_at
  ) values (
    p_organization_id, null, retained_profile.id, p_zernio_connection_id,
    trim(p_zernio_account_id), identity_value, connection_row.label,
    'duplicate_identity_auto_removed', 'zernio_sync_worker',
    'zernio_duplicate_identity_auto_removed',
    left(format(
      'Duplicidade observada: @%s preservado na chave %s (perfil %s); ocorrência excedente na chave %s.',
      identity_value,
      coalesce((select label from public.zernio_connections where id = retained_profile.zernio_connection_id), 'canônica'),
      retained_profile.id,
      connection_row.label
    ), 1200),
    desired_incident_state, block_reason, 1, timezone('utc', now())
  ) on conflict (organization_id, zernio_connection_id, zernio_account_id)
    where signal = 'duplicate_identity_auto_removed'
  do update set
    retained_profile_id = excluded.retained_profile_id,
    username_snapshot = excluded.username_snapshot,
    connection_label_snapshot = excluded.connection_label_snapshot,
    error_code = excluded.error_code,
    error_message = excluded.error_message,
    state = excluded.state,
    defer_reason = excluded.defer_reason,
    occurrence_count = public.zernio_profile_disconnection_incidents.occurrence_count + 1,
    last_observed_at = timezone('utc', now()),
    reopened_at = case
      when public.zernio_profile_disconnection_incidents.state in ('completed', 'dead_letter')
        then timezone('utc', now())
      else public.zernio_profile_disconnection_incidents.reopened_at
    end,
    finalized_at = case
      when public.zernio_profile_disconnection_incidents.state in ('completed', 'dead_letter') then null
      else public.zernio_profile_disconnection_incidents.finalized_at
    end
  returning * into incident_row;

  select job.status into previous_job_status
  from public.zernio_profile_recycling_jobs job
  where job.incident_id = incident_row.id
  for update;

  insert into public.zernio_profile_recycling_jobs (
    organization_id, incident_id, status, next_attempt_at, deferred_reason
  ) values (
    p_organization_id, incident_row.id, desired_job_status,
    case when block_reason is null then timezone('utc', now()) else timezone('utc', now()) + interval '5 minutes' end,
    block_reason
  ) on conflict (incident_id) do update set
    status = case
      when public.zernio_profile_recycling_jobs.status = 'processing'
        and public.zernio_profile_recycling_jobs.lease_until > timezone('utc', now())
        then 'processing'
      else excluded.status
    end,
    attempt_count = case
      when public.zernio_profile_recycling_jobs.status in ('completed', 'dead_letter') then 0
      else public.zernio_profile_recycling_jobs.attempt_count
    end,
    next_attempt_at = excluded.next_attempt_at,
    claimed_by = case
      when public.zernio_profile_recycling_jobs.status = 'processing'
        and public.zernio_profile_recycling_jobs.lease_until > timezone('utc', now())
        then public.zernio_profile_recycling_jobs.claimed_by
      else null
    end,
    lease_until = case
      when public.zernio_profile_recycling_jobs.status = 'processing'
        and public.zernio_profile_recycling_jobs.lease_until > timezone('utc', now())
        then public.zernio_profile_recycling_jobs.lease_until
      else null
    end,
    deferred_reason = excluded.deferred_reason,
    completed_at = null,
    dead_letter_at = null,
    reopened_count = public.zernio_profile_recycling_jobs.reopened_count
      + case when public.zernio_profile_recycling_jobs.status in ('completed', 'dead_letter') then 1 else 0 end,
    last_outcome = null,
    last_error_code = null,
    last_error_message = null
  returning * into job_row;

  insert into public.zernio_profile_recycling_job_events (
    organization_id, job_id, incident_id, event_type, previous_status,
    status, attempt_count, reason, metadata
  ) values (
    p_organization_id, job_row.id, incident_row.id,
    case
      when previous_job_status in ('completed', 'dead_letter') then 'reopened'
      when block_reason is not null then 'deferred'
      else 'scheduled'
    end,
    previous_job_status, job_row.status, job_row.attempt_count,
    block_reason,
    jsonb_build_object(
      'occurrenceCount', incident_row.occurrence_count,
      'freezeCorrelationId', control_row.freeze_correlation_id
    )
  );

  return jsonb_build_object(
    'scheduled', block_reason is null,
    'durable', true,
    'reason', block_reason,
    'incidentId', incident_row.id,
    'jobId', job_row.id,
    'jobStatus', job_row.status,
    'retainedProfileId', retained_profile.id,
    'duplicateProfileId', null,
    'occurrenceCount', incident_row.occurrence_count,
    'correlationId', control_row.freeze_correlation_id
  );
end;
$$;

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

  -- Jobs deferred continuam duráveis, mas sua próxima avaliação é espaçada
  -- enquanto o congelamento ou uma publicação ativa ainda bloqueiam o DELETE.
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
    returning job_id
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

create or replace function public.complete_zernio_profile_recycling(
  p_job_id uuid, p_worker_id text, p_remote_outcome text,
  p_http_status integer default null, p_request_id text default null,
  p_error_code text default null, p_error_message text default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  job_row public.zernio_profile_recycling_jobs%rowtype;
  incident_row public.zernio_profile_disconnection_incidents%rowtype;
  profile_row public.instagram_profiles%rowtype;
  ignored_count integer := 0;
  plan_count integer := 0;
  retry_seconds integer;
  affected_batch uuid;
  dead_letter_reason text;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao worker.';
  end if;
  if p_remote_outcome not in ('remote_deleted', 'already_disconnected_404', 'retryable_error', 'terminal_error') then
    raise exception using errcode = '22023', message = 'Resultado remoto inválido.';
  end if;

  select job.* into job_row
  from public.zernio_profile_recycling_jobs job
  where job.id = p_job_id
    and job.claimed_by = trim(p_worker_id)
    and job.lease_until > timezone('utc', now())
    and job.status = 'processing'
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Job não está sob lease deste worker.';
  end if;

  select incident.* into incident_row
  from public.zernio_profile_disconnection_incidents incident
  where incident.id = job_row.incident_id
    and incident.organization_id = job_row.organization_id
  for update;

  if p_remote_outcome in ('retryable_error', 'terminal_error') then
    if p_remote_outcome = 'terminal_error' or job_row.attempt_count >= job_row.max_attempts then
      dead_letter_reason := case
        when p_remote_outcome = 'terminal_error' then 'terminal_error'
        else 'max_attempts_exhausted'
      end;

      update public.zernio_profile_recycling_jobs set
        status = 'dead_letter', claimed_by = null, lease_until = null,
        last_http_status = p_http_status,
        last_request_id = left(nullif(trim(p_request_id), ''), 160),
        last_error_code = left(coalesce(nullif(trim(p_error_code), ''), dead_letter_reason), 120),
        last_error_message = left(coalesce(nullif(trim(p_error_message), ''), 'Falha terminal ao remover conta Zernio.'), 1200),
        last_outcome = p_remote_outcome,
        dead_letter_at = timezone('utc', now()),
        deferred_reason = dead_letter_reason
      where id = job_row.id;

      update public.zernio_profile_disconnection_incidents set
        state = 'dead_letter', remote_http_status = p_http_status,
        remote_request_id = left(nullif(trim(p_request_id), ''), 160),
        remote_result = p_remote_outcome,
        defer_reason = dead_letter_reason,
        finalized_at = timezone('utc', now())
      where id = incident_row.id;

      insert into public.zernio_profile_recycling_job_events (
        organization_id, job_id, incident_id, event_type,
        previous_status, status, attempt_count, reason, metadata
      ) values (
        job_row.organization_id, job_row.id, incident_row.id,
        'dead_lettered', 'processing', 'dead_letter', job_row.attempt_count,
        left(coalesce(nullif(trim(p_error_message), ''), dead_letter_reason), 1200),
        jsonb_build_object('httpStatus', p_http_status, 'errorCode', p_error_code, 'classification', dead_letter_reason)
      );

      return jsonb_build_object(
        'completed', false, 'deadLettered', true,
        'reason', dead_letter_reason, 'attemptCount', job_row.attempt_count
      );
    end if;

    retry_seconds := least(
      3600,
      60 * power(2, least(job_row.attempt_count - 1, 6))::integer
        + floor(random() * 31)::integer
    );

    update public.zernio_profile_recycling_jobs set
      status = 'retry_pending', claimed_by = null, lease_until = null,
      next_attempt_at = timezone('utc', now()) + make_interval(secs => retry_seconds),
      last_http_status = p_http_status,
      last_request_id = left(nullif(trim(p_request_id), ''), 160),
      last_error_code = left(nullif(trim(p_error_code), ''), 120),
      last_error_message = left(nullif(trim(p_error_message), ''), 1200),
      last_outcome = p_remote_outcome,
      deferred_reason = 'retryable_error'
    where id = job_row.id;

    update public.zernio_profile_disconnection_incidents set
      state = 'retry_scheduled', remote_http_status = p_http_status,
      remote_request_id = left(nullif(trim(p_request_id), ''), 160),
      remote_result = p_remote_outcome,
      defer_reason = 'retryable_error'
    where id = incident_row.id;

    insert into public.zernio_profile_recycling_job_events (
      organization_id, job_id, incident_id, event_type,
      previous_status, status, attempt_count, reason, metadata
    ) values (
      job_row.organization_id, job_row.id, incident_row.id,
      'retry_scheduled', 'processing', 'retry_pending', job_row.attempt_count,
      left(nullif(trim(p_error_message), ''), 1200),
      jsonb_build_object('retryAtSeconds', retry_seconds, 'httpStatus', p_http_status, 'errorCode', p_error_code)
    );

    return jsonb_build_object(
      'completed', false, 'deadLettered', false,
      'retryAtSeconds', retry_seconds, 'attemptCount', job_row.attempt_count
    );
  end if;

  select profile.* into profile_row
  from public.instagram_profiles profile
  where profile.id = incident_row.profile_id
    and profile.organization_id = incident_row.organization_id
  for update;

  if found and profile_row.deleted_at is null then
    with targets as (
      select item.id, item.status as previous_status
      from public.publication_items item
      where item.organization_id = incident_row.organization_id
        and item.profile_id = incident_row.profile_id
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
      select incident_row.organization_id, ignored.id, 'cancelled',
        ignored.previous_status, 'ignored', 'system: zernio-profile-recycling',
        'zernio_account_disconnected', 'Conta Zernio desconectada; publicação ignorada.',
        jsonb_build_object('incident_id', incident_row.id)
      from ignored returning publication_item_id
    ) select count(*)::integer into ignored_count from logged;

    ignored_count := ignored_count + 1;
    delete from public.publication_profile_daily_reservations reservation
    using public.publication_items item
    where reservation.publication_item_id = item.id
      and item.organization_id = incident_row.organization_id
      and item.profile_id = incident_row.profile_id
      and item.status = 'ignored';
    delete from public.publication_dispatch_rate_reservations reservation
    using public.publication_items item
    where reservation.publication_item_id = item.id
      and item.organization_id = incident_row.organization_id
      and item.profile_id = incident_row.profile_id
      and item.status = 'ignored';
    update public.bulk_publication_generation_chunks chunk set
      status = 'cancelled', completed_at = coalesce(completed_at, timezone('utc', now())),
      claimed_by = null, lease_until = null
    where chunk.organization_id = incident_row.organization_id
      and chunk.profile_id = incident_row.profile_id
      and chunk.status in ('queued', 'processing', 'failed', 'paused');
    update public.bulk_publication_profile_horizons horizon set
      status = 'cancelled', released_at = coalesce(released_at, timezone('utc', now()))
    where horizon.organization_id = incident_row.organization_id
      and horizon.profile_id = incident_row.profile_id
      and horizon.status = 'active';
    with updated_plans as (
      update public.bulk_publication_plan_profiles plan_profile set
        status = 'cancelled', suspended_at = coalesce(suspended_at, timezone('utc', now())),
        suspension_reason = 'Conta Zernio desconectada; perfil removido automaticamente.'
      where plan_profile.organization_id = incident_row.organization_id
        and plan_profile.profile_id = incident_row.profile_id
        and plan_profile.status in ('queued', 'generating', 'suspended')
      returning plan_profile.id
    ) select count(*)::integer into plan_count from updated_plans;
    delete from public.profile_group_members
    where organization_id = incident_row.organization_id
      and profile_id = incident_row.profile_id;
    update public.instagram_profiles set
      deleted_at = timezone('utc', now()), status = 'offline',
      last_error_code = 'zernio_account_disconnected',
      last_error_message = 'Conta desconectada na Zernio e removida automaticamente.'
    where id = profile_row.id and organization_id = profile_row.organization_id;
  end if;

  for affected_batch in
    select distinct item.batch_id
    from public.publication_items item
    where item.organization_id = incident_row.organization_id
      and item.profile_id = incident_row.profile_id
  loop
    perform public.sync_publication_batch_status(affected_batch);
  end loop;

  update public.zernio_profile_disconnection_incidents set
    state = 'completed',
    remote_http_status = coalesce(p_http_status, case when p_remote_outcome = 'already_disconnected_404' then 404 else 200 end),
    remote_request_id = left(nullif(trim(p_request_id), ''), 160),
    remote_result = p_remote_outcome,
    remote_completed_at = timezone('utc', now()),
    finalized_at = timezone('utc', now()),
    ignored_item_count = ignored_count,
    interrupted_plan_count = plan_count,
    defer_reason = null
  where id = incident_row.id;

  update public.zernio_profile_recycling_jobs set
    status = 'completed', claimed_by = null, lease_until = null,
    completed_at = timezone('utc', now()),
    last_http_status = coalesce(p_http_status, case when p_remote_outcome = 'already_disconnected_404' then 404 else 200 end),
    last_request_id = left(nullif(trim(p_request_id), ''), 160),
    last_error_code = null, last_error_message = null,
    last_outcome = p_remote_outcome, deferred_reason = null
  where id = job_row.id;

  insert into public.zernio_profile_recycling_job_events (
    organization_id, job_id, incident_id, event_type,
    previous_status, status, attempt_count, metadata
  ) values (
    job_row.organization_id, job_row.id, incident_row.id,
    'completed', 'processing', 'completed', job_row.attempt_count,
    jsonb_build_object('outcome', p_remote_outcome, 'httpStatus', p_http_status)
  );

  return jsonb_build_object(
    'completed', true, 'incidentId', incident_row.id,
    'ignoredItemCount', ignored_count, 'interruptedPlanCount', plan_count,
    'outcome', p_remote_outcome
  );
end;
$$;

create or replace function public.requeue_zernio_profile_recycling_dead_letter(
  p_job_id uuid,
  p_reason text,
  p_requested_by uuid default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  job_row public.zernio_profile_recycling_jobs%rowtype;
  incident_row public.zernio_profile_disconnection_incidents%rowtype;
begin
  select job.* into job_row
  from public.zernio_profile_recycling_jobs job
  where job.id = p_job_id
  for update;
  if not found then raise exception using errcode = 'P0002', message = 'Job não encontrado.'; end if;
  if auth.role() <> 'service_role'
    and not public.has_organization_role(job_row.organization_id, array['admin']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Somente administradores podem reprocessar dead-letter.';
  end if;
  if job_row.status <> 'dead_letter' then
    raise exception using errcode = '22023', message = 'Somente jobs em dead-letter podem ser reprocessados.';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception using errcode = '22023', message = 'O reprocessamento exige motivo.';
  end if;

  select incident.* into incident_row
  from public.zernio_profile_disconnection_incidents incident
  where incident.id = job_row.incident_id
  for update;

  update public.zernio_profile_recycling_jobs set
    status = 'pending', attempt_count = 0,
    next_attempt_at = timezone('utc', now()),
    claimed_by = null, lease_until = null,
    deferred_reason = null, dead_letter_at = null,
    completed_at = null, last_error_code = null,
    last_error_message = null, last_outcome = null,
    reopened_count = reopened_count + 1
  where id = job_row.id
  returning * into job_row;

  update public.zernio_profile_disconnection_incidents set
    state = 'remote_removal_pending', defer_reason = null,
    finalized_at = null, reopened_at = timezone('utc', now())
  where id = incident_row.id;

  insert into public.zernio_profile_recycling_job_events (
    organization_id, job_id, incident_id, event_type,
    previous_status, status, attempt_count, reason, metadata
  ) values (
    job_row.organization_id, job_row.id, incident_row.id,
    'reopened', 'dead_letter', 'pending', 0, left(trim(p_reason), 1200),
    jsonb_build_object('requestedBy', coalesce(p_requested_by, auth.uid()))
  );

  return jsonb_build_object('requeued', true, 'jobId', job_row.id, 'incidentId', incident_row.id);
end;
$$;

revoke all on function public.schedule_zernio_duplicate_identity_disconnection(uuid, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.schedule_zernio_duplicate_identity_disconnection(uuid, uuid, text, text, uuid) to service_role;
revoke all on function public.claim_zernio_profile_recycling_jobs(text, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_zernio_profile_recycling_jobs(text, integer, integer) to service_role;
revoke all on function public.complete_zernio_profile_recycling(uuid, text, text, integer, text, text, text) from public, anon, authenticated;
grant execute on function public.complete_zernio_profile_recycling(uuid, text, text, integer, text, text, text) to service_role;
revoke all on function public.requeue_zernio_profile_recycling_dead_letter(uuid, text, uuid) from public, anon;
grant execute on function public.requeue_zernio_profile_recycling_dead_letter(uuid, text, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
