-- Reciclagem idempotente de perfis Zernio que a própria Zernio informou como desconectados.
-- HTTP 404 no DELETE é sucesso: a conta já não existe remotamente e a limpeza local pode terminar.

create table public.zernio_profile_disconnection_incidents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  profile_id uuid not null references public.instagram_profiles(id) on delete restrict,
  zernio_connection_id uuid references public.zernio_connections(id) on delete set null,
  zernio_account_id text not null check (char_length(trim(zernio_account_id)) between 1 and 160),
  username_snapshot text not null check (char_length(trim(username_snapshot)) between 1 and 80),
  connection_label_snapshot text,
  signal text not null check (signal in ('account_disconnected', 'auth_expired')),
  source_item_id uuid references public.publication_items(id) on delete set null,
  source_batch_id uuid references public.publication_batches(id) on delete set null,
  source text not null default 'publication_worker' check (source in ('publication_worker', 'historical_backfill')),
  error_code text not null check (char_length(trim(error_code)) between 1 and 120),
  error_message text not null check (char_length(trim(error_message)) between 1 and 1200),
  state text not null default 'remote_removal_pending' check (state in ('remote_removal_pending', 'remote_deleted', 'already_disconnected_404', 'completed')),
  remote_http_status integer,
  remote_request_id text,
  remote_result text,
  detected_at timestamptz not null default timezone('utc', now()),
  remote_completed_at timestamptz,
  finalized_at timestamptz,
  ignored_item_count integer not null default 0 check (ignored_item_count >= 0),
  interrupted_plan_count integer not null default 0 check (interrupted_plan_count >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (organization_id, profile_id),
  check (remote_http_status is null or remote_http_status between 100 and 599),
  check ((state <> 'completed') or finalized_at is not null)
);

create table public.zernio_profile_recycling_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  incident_id uuid not null unique references public.zernio_profile_disconnection_incidents(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'processing', 'remote_removal_pending', 'completed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default timezone('utc', now()),
  claimed_by text check (claimed_by is null or char_length(trim(claimed_by)) between 3 and 120),
  lease_until timestamptz,
  last_http_status integer,
  last_request_id text,
  last_error_code text,
  last_error_message text,
  completed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (last_http_status is null or last_http_status between 100 and 599)
);

create index zernio_disconnection_incidents_org_detected_idx
  on public.zernio_profile_disconnection_incidents(organization_id, detected_at desc);
create index zernio_disconnection_incidents_org_connection_idx
  on public.zernio_profile_disconnection_incidents(organization_id, zernio_connection_id, detected_at desc);
create index zernio_recycling_jobs_claim_idx
  on public.zernio_profile_recycling_jobs(status, next_attempt_at, lease_until, created_at)
  where status in ('pending', 'processing', 'remote_removal_pending');

create trigger zernio_disconnection_incidents_set_updated_at
before update on public.zernio_profile_disconnection_incidents
for each row execute function public.set_updated_at();
create trigger zernio_recycling_jobs_set_updated_at
before update on public.zernio_profile_recycling_jobs
for each row execute function public.set_updated_at();

alter table public.zernio_profile_disconnection_incidents enable row level security;
alter table public.zernio_profile_recycling_jobs enable row level security;
create policy zernio_disconnection_incidents_select_member
  on public.zernio_profile_disconnection_incidents for select to authenticated
  using (public.is_organization_member(organization_id));
revoke all on public.zernio_profile_disconnection_incidents, public.zernio_profile_recycling_jobs from public, anon, authenticated;
grant select on public.zernio_profile_disconnection_incidents to authenticated;
grant all on public.zernio_profile_disconnection_incidents, public.zernio_profile_recycling_jobs to service_role;

create or replace function public.schedule_zernio_profile_disconnection(
  p_item_id uuid,
  p_worker_id text,
  p_signal text,
  p_error_code text,
  p_error_message text,
  p_revert_claim_attempt boolean default false
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  item_row public.publication_items%rowtype;
  profile_row public.instagram_profiles%rowtype;
  connection_label text;
  incident_row public.zernio_profile_disconnection_incidents%rowtype;
  previous_attempt_count integer;
begin
  if auth.role() <> 'service_role' then raise exception using errcode = '42501', message = 'Ação permitida somente ao worker.'; end if;
  if p_signal not in ('account_disconnected', 'auth_expired') then raise exception using errcode = '22023', message = 'Sinal de desconexão Zernio inválido.'; end if;
  select item.* into item_row from public.publication_items item
  where item.id = p_item_id and item.claimed_by = trim(p_worker_id)
    and item.lease_until > timezone('utc', now()) and item.status in ('preparing', 'publishing')
  for update;
  if not found then raise exception using errcode = 'P0002', message = 'Item não está sob lease deste worker.'; end if;
  select profile.* into profile_row from public.instagram_profiles profile
  where profile.id = item_row.profile_id and profile.organization_id = item_row.organization_id
    and profile.provider = 'zernio' and profile.deleted_at is null
  for update;
  if not found or coalesce(nullif(trim(profile_row.zernio_account_id), ''), '') = '' then
    raise exception using errcode = 'P0002', message = 'Perfil Zernio ativo não encontrado.';
  end if;
  select label into connection_label from public.zernio_connections connection
  where connection.id = profile_row.zernio_connection_id and connection.organization_id = profile_row.organization_id;

  insert into public.zernio_profile_disconnection_incidents (
    organization_id, profile_id, zernio_connection_id, zernio_account_id, username_snapshot, connection_label_snapshot,
    signal, source_item_id, source_batch_id, error_code, error_message
  ) values (
    item_row.organization_id, profile_row.id, profile_row.zernio_connection_id, profile_row.zernio_account_id,
    profile_row.username, connection_label, p_signal, item_row.id, item_row.batch_id,
    left(coalesce(nullif(trim(p_error_code), ''), 'zernio_account_disconnected'), 120),
    left(coalesce(nullif(trim(p_error_message), ''), 'A Zernio informou que a conta foi desconectada.'), 1200)
  ) on conflict (organization_id, profile_id) do update set updated_at = timezone('utc', now())
  returning * into incident_row;

  insert into public.zernio_profile_recycling_jobs (organization_id, incident_id)
  values (item_row.organization_id, incident_row.id)
  on conflict (incident_id) do nothing;

  previous_attempt_count := item_row.attempt_count;
  update public.publication_items item
  set status = 'ignored', claimed_by = null, lease_until = null, next_attempt_at = null,
      -- Queda terminal não permanece em nenhuma contagem de tentativa.
      attempt_count = 0,
      last_error_code = 'zernio_account_disconnected',
      last_error_message = 'Conta Zernio desconectada; perfil encaminhado para remoção automática.'
  where item.id = item_row.id;
  delete from public.publication_profile_daily_reservations where publication_item_id = item_row.id;
  delete from public.publication_dispatch_rate_reservations where publication_item_id = item_row.id;
  perform public.log_publication_item_event(item_row.id, 'cancelled', item_row.status, 'ignored', null, trim(p_worker_id),
    'zernio_account_disconnected', 'Conta Zernio desconectada; item ignorado sem falha ou retentativa.',
    jsonb_build_object('incident_id', incident_row.id, 'attempt_reverted', p_revert_claim_attempt, 'previous_attempt_count', previous_attempt_count));
  perform public.sync_publication_batch_status(item_row.batch_id);
  return jsonb_build_object('incidentId', incident_row.id, 'scheduled', true);
end;
$$;

create or replace function public.claim_zernio_profile_recycling_jobs(
  p_worker_id text, p_limit integer default 10, p_lease_seconds integer default 180
)
returns table (job_id uuid, incident_id uuid, organization_id uuid, zernio_connection_id uuid, zernio_account_id text, attempt_count integer)
language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then raise exception using errcode = '42501', message = 'Ação permitida somente ao worker.'; end if;
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 or p_limit not between 1 and 100 or p_lease_seconds not between 30 and 900 then
    raise exception using errcode = '22023', message = 'Parâmetros de claim inválidos.';
  end if;
  return query with candidates as (
    select job.id from public.zernio_profile_recycling_jobs job
    where job.status in ('pending', 'remote_removal_pending', 'processing')
      and job.next_attempt_at <= timezone('utc', now())
      and (job.lease_until is null or job.lease_until <= timezone('utc', now()))
    order by job.next_attempt_at, job.created_at, job.id for update skip locked limit p_limit
  ), claimed as (
    update public.zernio_profile_recycling_jobs job set status = 'processing', claimed_by = trim(p_worker_id),
      lease_until = timezone('utc', now()) + make_interval(secs => p_lease_seconds), attempt_count = job.attempt_count + 1
    from candidates where job.id = candidates.id
    returning job.id, job.incident_id, job.organization_id, job.attempt_count
  )
  select claimed.id, claimed.incident_id, claimed.organization_id, incident.zernio_connection_id, incident.zernio_account_id, claimed.attempt_count
  from claimed join public.zernio_profile_disconnection_incidents incident on incident.id = claimed.incident_id
  where incident.organization_id = claimed.organization_id;
end;
$$;

create or replace function public.complete_zernio_profile_recycling(
  p_job_id uuid, p_worker_id text, p_remote_outcome text, p_http_status integer default null,
  p_request_id text default null, p_error_code text default null, p_error_message text default null
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
begin
  if auth.role() <> 'service_role' then raise exception using errcode = '42501', message = 'Ação permitida somente ao worker.'; end if;
  if p_remote_outcome not in ('remote_deleted', 'already_disconnected_404', 'retryable_error', 'terminal_error') then
    raise exception using errcode = '22023', message = 'Resultado remoto inválido.';
  end if;
  select job.* into job_row from public.zernio_profile_recycling_jobs job
  where job.id = p_job_id and job.claimed_by = trim(p_worker_id) and job.lease_until > timezone('utc', now()) and job.status = 'processing'
  for update;
  if not found then raise exception using errcode = 'P0002', message = 'Job não está sob lease deste worker.'; end if;
  select incident.* into incident_row from public.zernio_profile_disconnection_incidents incident
  where incident.id = job_row.incident_id and incident.organization_id = job_row.organization_id for update;

  if p_remote_outcome in ('retryable_error', 'terminal_error') then
    retry_seconds := least(3600, 60 * power(2, least(job_row.attempt_count - 1, 6))::integer);
    update public.zernio_profile_recycling_jobs set status = 'remote_removal_pending', claimed_by = null, lease_until = null,
      next_attempt_at = timezone('utc', now()) + make_interval(secs => retry_seconds), last_http_status = p_http_status,
      last_request_id = left(nullif(trim(p_request_id), ''), 160), last_error_code = left(nullif(trim(p_error_code), ''), 120),
      last_error_message = left(nullif(trim(p_error_message), ''), 1200) where id = job_row.id;
    update public.zernio_profile_disconnection_incidents set state = 'remote_removal_pending', remote_http_status = p_http_status,
      remote_request_id = left(nullif(trim(p_request_id), ''), 160), remote_result = p_remote_outcome where id = incident_row.id;
    return jsonb_build_object('completed', false, 'retryAtSeconds', retry_seconds);
  end if;

  select profile.* into profile_row from public.instagram_profiles profile
  where profile.id = incident_row.profile_id and profile.organization_id = incident_row.organization_id for update;
  if found and profile_row.deleted_at is null then
    with targets as (
      select item.id, item.status as previous_status
      from public.publication_items item
      where item.organization_id = incident_row.organization_id and item.profile_id = incident_row.profile_id
        and item.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended')
      for update
    ), ignored as (
      update public.publication_items item set status = 'ignored', claimed_by = null, lease_until = null, next_attempt_at = null,
        attempt_count = 0, last_error_code = 'zernio_account_disconnected', last_error_message = 'Conta Zernio desconectada; publicação ignorada.'
      from targets
      where item.id = targets.id
      returning item.id, targets.previous_status
    ), logged as (
      insert into public.publication_item_events (organization_id, publication_item_id, event_type, previous_status, status, actor_label, error_code, error_message, metadata)
      select incident_row.organization_id, ignored.id, 'cancelled', ignored.previous_status, 'ignored', 'system: zernio-profile-recycling',
      'zernio_account_disconnected', 'Conta Zernio desconectada; publicação ignorada.', jsonb_build_object('incident_id', incident_row.id)
      from ignored
      returning publication_item_id
    ) select count(*)::integer into ignored_count from logged;
    -- O item que detectou a queda já foi ignorado pelo agendamento do incidente.
    ignored_count := ignored_count + 1;
    delete from public.publication_profile_daily_reservations reservation using public.publication_items item
      where reservation.publication_item_id = item.id and item.organization_id = incident_row.organization_id and item.profile_id = incident_row.profile_id and item.status = 'ignored';
    delete from public.publication_dispatch_rate_reservations reservation using public.publication_items item
      where reservation.publication_item_id = item.id and item.organization_id = incident_row.organization_id and item.profile_id = incident_row.profile_id and item.status = 'ignored';
    update public.bulk_publication_generation_chunks chunk set status = 'cancelled', completed_at = coalesce(completed_at, timezone('utc', now())),
      claimed_by = null, lease_until = null where chunk.organization_id = incident_row.organization_id and chunk.profile_id = incident_row.profile_id and chunk.status in ('queued', 'processing', 'failed', 'paused');
    update public.bulk_publication_profile_horizons horizon set status = 'cancelled', released_at = coalesce(released_at, timezone('utc', now()))
      where horizon.organization_id = incident_row.organization_id and horizon.profile_id = incident_row.profile_id and horizon.status = 'active';
    with updated_plans as (
      update public.bulk_publication_plan_profiles plan_profile set status = 'cancelled', suspended_at = coalesce(suspended_at, timezone('utc', now())),
        suspension_reason = 'Conta Zernio desconectada; perfil removido automaticamente.'
      where plan_profile.organization_id = incident_row.organization_id and plan_profile.profile_id = incident_row.profile_id
        and plan_profile.status in ('queued', 'generating', 'suspended') returning plan_profile.id
    ) select count(*)::integer into plan_count from updated_plans;
    delete from public.profile_group_members where organization_id = incident_row.organization_id and profile_id = incident_row.profile_id;
    update public.instagram_profiles set deleted_at = timezone('utc', now()), status = 'offline', last_error_code = 'zernio_account_disconnected',
      last_error_message = 'Conta desconectada na Zernio e removida automaticamente.' where id = profile_row.id and organization_id = profile_row.organization_id;
  end if;
  for affected_batch in select distinct item.batch_id from public.publication_items item where item.organization_id = incident_row.organization_id and item.profile_id = incident_row.profile_id loop
    perform public.sync_publication_batch_status(affected_batch);
  end loop;
  update public.zernio_profile_disconnection_incidents set state = 'completed', remote_http_status = coalesce(p_http_status, case when p_remote_outcome = 'already_disconnected_404' then 404 else 200 end),
    remote_request_id = left(nullif(trim(p_request_id), ''), 160), remote_result = p_remote_outcome, remote_completed_at = timezone('utc', now()), finalized_at = timezone('utc', now()),
    ignored_item_count = ignored_count, interrupted_plan_count = plan_count where id = incident_row.id;
  update public.zernio_profile_recycling_jobs set status = 'completed', claimed_by = null, lease_until = null, completed_at = timezone('utc', now()),
    last_http_status = coalesce(p_http_status, case when p_remote_outcome = 'already_disconnected_404' then 404 else 200 end), last_request_id = left(nullif(trim(p_request_id), ''), 160),
    last_error_code = null, last_error_message = null where id = job_row.id;
  return jsonb_build_object('completed', true, 'incidentId', incident_row.id, 'ignoredItemCount', ignored_count, 'interruptedPlanCount', plan_count, 'outcome', p_remote_outcome);
end;
$$;

revoke all on function public.schedule_zernio_profile_disconnection(uuid, text, text, text, text, boolean) from public, anon, authenticated;
revoke all on function public.claim_zernio_profile_recycling_jobs(text, integer, integer) from public, anon, authenticated;
revoke all on function public.complete_zernio_profile_recycling(uuid, text, text, integer, text, text, text) from public, anon, authenticated;
grant execute on function public.schedule_zernio_profile_disconnection(uuid, text, text, text, text, boolean) to service_role;
grant execute on function public.claim_zernio_profile_recycling_jobs(text, integer, integer) to service_role;
grant execute on function public.complete_zernio_profile_recycling(uuid, text, text, integer, text, text, text) to service_role;
