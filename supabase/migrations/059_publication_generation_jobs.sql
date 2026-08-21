-- Infraestrutura para geração assíncrona de grandes agendamentos.
-- Esta migration não altera o fluxo síncrono atual; apenas cria as estruturas
-- para que um worker externo possa expandir planos grandes em chunks seguros.

create table if not exists public.publication_generation_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  created_by uuid not null references auth.users (id) on delete restrict,
  created_by_email text,
  name text check (name is null or char_length(trim(name)) between 1 and 160),
  status text not null default 'queued' check (status in ('queued', 'processing', 'paused', 'completed', 'failed', 'cancelled')),
  scheduled_for timestamptz,
  payload jsonb not null default '{}'::jsonb,
  expected_items integer check (expected_items is null or expected_items >= 0),
  generated_items integer not null default 0 check (generated_items >= 0),
  failed_items integer not null default 0 check (failed_items >= 0),
  chunk_size integer not null default 500 check (chunk_size between 1 and 1000),
  chunk_count integer not null default 0 check (chunk_count >= 0),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  claimed_by text,
  lease_until timestamptz,
  last_error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  completed_at timestamptz
);

create table if not exists public.publication_generation_job_chunks (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.publication_generation_jobs (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  chunk_index integer not null check (chunk_index >= 0),
  status text not null default 'queued' check (status in ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  payload jsonb not null default '[]'::jsonb,
  expected_items integer check (expected_items is null or expected_items >= 0),
  generated_items integer not null default 0 check (generated_items >= 0),
  failed_items integer not null default 0 check (failed_items >= 0),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  claimed_by text,
  lease_until timestamptz,
  last_error_message text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  completed_at timestamptz,
  unique (job_id, chunk_index)
);

create table if not exists public.publication_generation_job_events (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.publication_generation_jobs (id) on delete cascade,
  chunk_id uuid references public.publication_generation_job_chunks (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  event_type text not null check (char_length(trim(event_type)) between 2 and 80),
  previous_status text,
  status text,
  actor_user_id uuid references auth.users (id) on delete set null,
  actor_label text,
  message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists publication_generation_jobs_org_status_updated_idx
  on public.publication_generation_jobs (organization_id, status, updated_at desc);

create index if not exists publication_generation_jobs_claim_idx
  on public.publication_generation_jobs (status, lease_until, created_at)
  where status in ('queued', 'processing');

create index if not exists publication_generation_chunks_job_status_idx
  on public.publication_generation_job_chunks (job_id, status, chunk_index);

create index if not exists publication_generation_chunks_claim_idx
  on public.publication_generation_job_chunks (status, lease_until, created_at)
  where status in ('queued', 'processing');

create index if not exists publication_generation_events_job_created_idx
  on public.publication_generation_job_events (job_id, created_at desc);

drop trigger if exists publication_generation_jobs_set_updated_at on public.publication_generation_jobs;
create trigger publication_generation_jobs_set_updated_at
before update on public.publication_generation_jobs
for each row execute function public.set_updated_at();

drop trigger if exists publication_generation_chunks_set_updated_at on public.publication_generation_job_chunks;
create trigger publication_generation_chunks_set_updated_at
before update on public.publication_generation_job_chunks
for each row execute function public.set_updated_at();

alter table public.publication_generation_jobs enable row level security;
alter table public.publication_generation_job_chunks enable row level security;
alter table public.publication_generation_job_events enable row level security;

drop policy if exists publication_generation_jobs_select_member on public.publication_generation_jobs;
create policy publication_generation_jobs_select_member
on public.publication_generation_jobs for select to authenticated
using (public.is_organization_member(organization_id));

drop policy if exists publication_generation_jobs_insert_operator on public.publication_generation_jobs;
create policy publication_generation_jobs_insert_operator
on public.publication_generation_jobs for insert to authenticated
with check (created_by = (select auth.uid()) and public.has_organization_role(organization_id, array['admin', 'operator']::public.organization_role[]));

drop policy if exists publication_generation_jobs_update_operator on public.publication_generation_jobs;
create policy publication_generation_jobs_update_operator
on public.publication_generation_jobs for update to authenticated
using (public.has_organization_role(organization_id, array['admin', 'operator']::public.organization_role[]))
with check (public.has_organization_role(organization_id, array['admin', 'operator']::public.organization_role[]));

drop policy if exists publication_generation_chunks_select_member on public.publication_generation_job_chunks;
create policy publication_generation_chunks_select_member
on public.publication_generation_job_chunks for select to authenticated
using (public.is_organization_member(organization_id));

drop policy if exists publication_generation_events_select_member on public.publication_generation_job_events;
create policy publication_generation_events_select_member
on public.publication_generation_job_events for select to authenticated
using (public.is_organization_member(organization_id));

revoke all on table public.publication_generation_jobs, public.publication_generation_job_chunks, public.publication_generation_job_events from anon;
grant select, insert, update on table public.publication_generation_jobs to authenticated;
grant select on table public.publication_generation_job_chunks, public.publication_generation_job_events to authenticated;

create or replace function public.log_publication_generation_job_event(
  p_job_id uuid,
  p_event_type text,
  p_previous_status text default null,
  p_status text default null,
  p_chunk_id uuid default null,
  p_actor_user_id uuid default null,
  p_actor_label text default null,
  p_message text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  job_organization_id uuid;
begin
  select organization_id into job_organization_id
  from public.publication_generation_jobs
  where id = p_job_id;

  if job_organization_id is null then
    raise exception using errcode = 'P0002', message = 'Job de geração não encontrado.';
  end if;

  insert into public.publication_generation_job_events (
    job_id, chunk_id, organization_id, event_type, previous_status, status,
    actor_user_id, actor_label, message, metadata
  ) values (
    p_job_id, p_chunk_id, job_organization_id, trim(p_event_type), p_previous_status, p_status,
    p_actor_user_id, p_actor_label, p_message, coalesce(p_metadata, '{}'::jsonb)
  );
end;
$$;

create or replace function public.create_publication_generation_job(
  p_organization_id uuid,
  p_name text,
  p_scheduled_for timestamptz,
  p_payload jsonb,
  p_expected_items integer default null,
  p_chunk_size integer default 500,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  job_row public.publication_generation_jobs%rowtype;
begin
  if not public.has_organization_role(p_organization_id, array['admin', 'operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;
  if jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'Payload de geração inválido.';
  end if;
  if p_expected_items is not null and p_expected_items < 1 then
    raise exception using errcode = '22023', message = 'Quantidade esperada inválida.';
  end if;
  if p_chunk_size not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'Tamanho de chunk deve estar entre 1 e 1000.';
  end if;

  insert into public.publication_generation_jobs (
    organization_id, created_by, created_by_email, name, scheduled_for,
    payload, expected_items, chunk_size, metadata
  ) values (
    p_organization_id, auth.uid(), nullif(auth.jwt() ->> 'email', ''),
    nullif(left(trim(coalesce(p_name, '')), 160), ''), p_scheduled_for,
    p_payload, p_expected_items, p_chunk_size, coalesce(p_metadata, '{}'::jsonb)
  ) returning * into job_row;

  perform public.log_publication_generation_job_event(
    job_row.id, 'queued', null, job_row.status, null, auth.uid(), auth.jwt() ->> 'email',
    'Job de geração criado.', jsonb_build_object('expected_items', job_row.expected_items, 'chunk_size', job_row.chunk_size)
  );

  return jsonb_build_object('job', to_jsonb(job_row));
end;
$$;

create or replace function public.claim_publication_generation_jobs(
  p_worker_id text,
  p_limit integer default 1,
  p_lease_seconds integer default 300
)
returns table (
  id uuid,
  organization_id uuid,
  name text,
  status text,
  scheduled_for timestamptz,
  payload jsonb,
  expected_items integer,
  generated_items integer,
  failed_items integer,
  chunk_size integer,
  attempt_count integer,
  lease_until timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido.';
  end if;
  if p_limit not between 1 and 20 then
    raise exception using errcode = '22023', message = 'Limite de claim deve estar entre 1 e 20.';
  end if;
  if p_lease_seconds not between 60 and 3600 then
    raise exception using errcode = '22023', message = 'Lease deve estar entre 60 e 3600 segundos.';
  end if;

  return query
  with candidates as (
    select job_row.id
    from public.publication_generation_jobs as job_row
    where job_row.status in ('queued', 'processing')
      and (job_row.lease_until is null or job_row.lease_until <= timezone('utc', now()))
    order by job_row.created_at, job_row.id
    for update skip locked
    limit p_limit
  ), claimed as (
    update public.publication_generation_jobs as job_row
    set
      status = 'processing',
      claimed_by = trim(p_worker_id),
      lease_until = timezone('utc', now()) + make_interval(secs => p_lease_seconds),
      attempt_count = job_row.attempt_count + 1,
      last_error_message = null
    from candidates
    where job_row.id = candidates.id
    returning job_row.id, job_row.organization_id, job_row.name, job_row.status,
      job_row.scheduled_for, job_row.payload, job_row.expected_items, job_row.generated_items,
      job_row.failed_items, job_row.chunk_size, job_row.attempt_count, job_row.lease_until
  )
  select * from claimed;
end;
$$;

create or replace function public.complete_publication_generation_job(
  p_job_id uuid,
  p_worker_id text,
  p_status text,
  p_generated_items integer default 0,
  p_failed_items integer default 0,
  p_error_message text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns public.publication_generation_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  previous_status text;
  job_row public.publication_generation_jobs%rowtype;
begin
  if p_status not in ('completed', 'failed', 'cancelled', 'paused', 'queued') then
    raise exception using errcode = '22023', message = 'Status final inválido.';
  end if;

  select status into previous_status
  from public.publication_generation_jobs
  where id = p_job_id
    and claimed_by = p_worker_id;

  if previous_status is null then
    raise exception using errcode = 'P0002', message = 'Job não encontrado ou pertence a outro worker.';
  end if;

  update public.publication_generation_jobs
  set
    status = p_status,
    generated_items = greatest(publication_generation_jobs.generated_items, coalesce(p_generated_items, 0)),
    failed_items = greatest(publication_generation_jobs.failed_items, coalesce(p_failed_items, 0)),
    claimed_by = null,
    lease_until = null,
    last_error_message = p_error_message,
    metadata = publication_generation_jobs.metadata || coalesce(p_metadata, '{}'::jsonb),
    completed_at = case when p_status in ('completed', 'failed', 'cancelled') then timezone('utc', now()) else completed_at end
  where id = p_job_id
    and claimed_by = p_worker_id
  returning * into job_row;

  perform public.log_publication_generation_job_event(
    p_job_id, p_status, previous_status, p_status, null, null, p_worker_id,
    p_error_message, coalesce(p_metadata, '{}'::jsonb)
  );

  return job_row;
end;
$$;

revoke all on function public.log_publication_generation_job_event(uuid, text, text, text, uuid, uuid, text, text, jsonb) from public, anon;
revoke all on function public.create_publication_generation_job(uuid, text, timestamptz, jsonb, integer, integer, jsonb) from public, anon;
revoke all on function public.claim_publication_generation_jobs(text, integer, integer) from public, anon, authenticated;
revoke all on function public.complete_publication_generation_job(uuid, text, text, integer, integer, text, jsonb) from public, anon, authenticated;

grant execute on function public.log_publication_generation_job_event(uuid, text, text, text, uuid, uuid, text, text, jsonb) to authenticated, service_role;
grant execute on function public.create_publication_generation_job(uuid, text, timestamptz, jsonb, integer, integer, jsonb) to authenticated;
grant execute on function public.claim_publication_generation_jobs(text, integer, integer) to service_role;
grant execute on function public.complete_publication_generation_job(uuid, text, text, integer, integer, text, jsonb) to service_role;
