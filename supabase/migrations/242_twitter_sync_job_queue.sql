create table public.twitter_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  connection_id uuid not null references public.twitter_connections (id) on delete restrict,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'succeeded', 'failed', 'cancelled')),
  idempotency_key text not null check (char_length(trim(idempotency_key)) between 8 and 255),
  requested_by uuid references auth.users (id) on delete set null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  claimed_by text,
  claim_token uuid,
  claimed_at timestamptz,
  lease_until timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  result jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (organization_id, idempotency_key)
);

create unique index twitter_sync_jobs_one_active_connection_idx
  on public.twitter_sync_jobs (connection_id)
  where status in ('pending', 'processing');

create index twitter_sync_jobs_claim_idx
  on public.twitter_sync_jobs (status, lease_until, created_at);

create trigger twitter_sync_jobs_set_updated_at
before update on public.twitter_sync_jobs
for each row execute function public.set_updated_at();

alter table public.twitter_connection_events
  drop constraint twitter_connection_events_event_type_check;
alter table public.twitter_connection_events
  add constraint twitter_connection_events_event_type_check check (event_type in (
    'credential_created', 'credential_rotated', 'oauth_started', 'oauth_completed',
    'sync_enqueued', 'sync_completed', 'sync_failed', 'profile_connected',
    'profile_reauthenticated', 'profile_epoch_changed', 'connection_deleted'
  ));

create or replace function public.twitter_enqueue_sync_job(
  p_organization_id uuid,
  p_connection_id uuid,
  p_actor_user_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  connection_row public.twitter_connections;
  job_row public.twitter_sync_jobs;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Apenas service_role pode enfileirar sync X.';
  end if;
  if char_length(trim(coalesce(p_idempotency_key, ''))) not between 8 and 255 then
    raise exception using errcode = '22023', message = 'Idempotency key inválida.';
  end if;

  select * into connection_row
  from public.twitter_connections
  where id = p_connection_id
    and organization_id = p_organization_id
    and status <> 'deleted'
    and deleted_at is null;
  if not found or connection_row.zernio_profile_id is null then
    raise exception using errcode = 'P0002', message = 'Conexão X ativa não encontrada.';
  end if;

  select * into job_row
  from public.twitter_sync_jobs
  where organization_id = p_organization_id
    and idempotency_key = trim(p_idempotency_key);
  if found then
    return jsonb_build_object('jobId', job_row.id, 'status', job_row.status, 'idempotentReplay', true);
  end if;

  select * into job_row
  from public.twitter_sync_jobs
  where connection_id = p_connection_id
    and status in ('pending', 'processing')
  order by created_at
  limit 1;
  if found then
    return jsonb_build_object('jobId', job_row.id, 'status', job_row.status, 'joinedActiveJob', true);
  end if;

  begin
    insert into public.twitter_sync_jobs (
      organization_id, connection_id, idempotency_key, requested_by
    ) values (
      p_organization_id, p_connection_id, trim(p_idempotency_key), p_actor_user_id
    ) returning * into job_row;
  exception when unique_violation then
    select * into job_row
    from public.twitter_sync_jobs
    where organization_id = p_organization_id
      and (
        idempotency_key = trim(p_idempotency_key)
        or (connection_id = p_connection_id and status in ('pending', 'processing'))
      )
    order by case when idempotency_key = trim(p_idempotency_key) then 0 else 1 end, created_at
    limit 1;
    if not found then raise; end if;
    return jsonb_build_object('jobId', job_row.id, 'status', job_row.status, 'joinedConcurrentJob', true);
  end;

  insert into public.twitter_connection_events (
    organization_id, connection_id, event_type, message, metadata
  ) values (
    p_organization_id, p_connection_id, 'sync_enqueued',
    'Sincronização X enfileirada para o worker dedicado.',
    jsonb_build_object('jobId', job_row.id)
  );

  return jsonb_build_object('jobId', job_row.id, 'status', job_row.status, 'idempotentReplay', false);
end;
$$;

create or replace function public.twitter_claim_sync_jobs(
  p_worker_id text,
  p_limit integer default 1,
  p_lease_seconds integer default 300
)
returns table (
  job_id uuid,
  organization_id uuid,
  connection_id uuid,
  zernio_profile_id text,
  encrypted_api_key text,
  claim_token uuid,
  attempt_count integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Apenas service_role pode executar claim de sync X.';
  end if;
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 255 then
    raise exception using errcode = '22023', message = 'Worker ID inválido.';
  end if;

  return query
  with candidates as (
    select job.id
    from public.twitter_sync_jobs job
    join public.twitter_connections connection on connection.id = job.connection_id
    where (
      job.status = 'pending'
      or (job.status = 'processing' and job.lease_until < timezone('utc', now()))
    )
      and connection.status <> 'deleted'
      and connection.deleted_at is null
    order by job.created_at, job.id
    for update of job skip locked
    limit least(greatest(coalesce(p_limit, 1), 1), 10)
  ), claimed as (
    update public.twitter_sync_jobs job
    set status = 'processing',
        claimed_by = trim(p_worker_id),
        claim_token = gen_random_uuid(),
        claimed_at = timezone('utc', now()),
        lease_until = timezone('utc', now()) + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 300), 60), 900)),
        started_at = coalesce(job.started_at, timezone('utc', now())),
        attempt_count = job.attempt_count + 1,
        error_code = null,
        error_message = null
    from candidates
    where job.id = candidates.id
    returning job.*
  )
  select claimed.id, claimed.organization_id, claimed.connection_id,
         connection.zernio_profile_id, secret.encrypted_api_key,
         claimed.claim_token, claimed.attempt_count
  from claimed
  join public.twitter_connections connection on connection.id = claimed.connection_id
  join public.twitter_connection_secrets secret on secret.connection_id = claimed.connection_id;
end;
$$;

create or replace function public.twitter_complete_sync_job(
  p_job_id uuid,
  p_claim_token uuid,
  p_succeeded boolean,
  p_result jsonb default '{}'::jsonb,
  p_error_code text default null,
  p_error_message text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  job_row public.twitter_sync_jobs;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Apenas service_role pode concluir sync X.';
  end if;

  select * into job_row from public.twitter_sync_jobs where id = p_job_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Job de sync X não encontrado.';
  end if;
  if job_row.status in ('succeeded', 'failed', 'cancelled') then
    return jsonb_build_object('jobId', job_row.id, 'status', job_row.status, 'idempotentReplay', true);
  end if;
  if job_row.status <> 'processing' or job_row.claim_token is distinct from p_claim_token then
    raise exception using errcode = '55000', message = 'Claim de sync X não é mais válido.';
  end if;

  update public.twitter_sync_jobs
  set status = case when p_succeeded then 'succeeded' else 'failed' end,
      result = case when p_succeeded then coalesce(p_result, '{}'::jsonb) else '{}'::jsonb end,
      error_code = case when p_succeeded then null else left(coalesce(p_error_code, 'sync_failed'), 120) end,
      error_message = case when p_succeeded then null else left(coalesce(p_error_message, 'Falha na sincronização X.'), 700) end,
      finished_at = timezone('utc', now()),
      lease_until = null
  where id = job_row.id
  returning * into job_row;

  if not p_succeeded then
    update public.twitter_connections
    set last_error_code = job_row.error_code,
        last_error_message = job_row.error_message
    where id = job_row.connection_id and organization_id = job_row.organization_id;
    insert into public.twitter_connection_events (
      organization_id, connection_id, event_type, message, metadata
    ) values (
      job_row.organization_id, job_row.connection_id, 'sync_failed',
      'Sincronização X falhou no worker dedicado.',
      jsonb_build_object('jobId', job_row.id, 'errorCode', job_row.error_code)
    );
  end if;

  return jsonb_build_object('jobId', job_row.id, 'status', job_row.status, 'idempotentReplay', false);
end;
$$;

alter table public.twitter_sync_jobs enable row level security;

create policy twitter_sync_jobs_select_member
on public.twitter_sync_jobs for select to authenticated
using (public.is_organization_member(organization_id));

revoke all on table public.twitter_sync_jobs from anon, authenticated;
grant select on table public.twitter_sync_jobs to authenticated;
grant all on table public.twitter_sync_jobs to service_role;

revoke all on function public.twitter_enqueue_sync_job(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.twitter_claim_sync_jobs(text, integer, integer) from public, anon, authenticated;
revoke all on function public.twitter_complete_sync_job(uuid, uuid, boolean, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.twitter_enqueue_sync_job(uuid, uuid, uuid, text) to service_role;
grant execute on function public.twitter_claim_sync_jobs(text, integer, integer) to service_role;
grant execute on function public.twitter_complete_sync_job(uuid, uuid, boolean, jsonb, text, text) to service_role;
