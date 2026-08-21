-- Athena Scheduler: claim atômico, lease, retry e dead-letter por item de analytics.

alter table public.profile_analytics_refresh_jobs
  add column if not exists partial_count integer not null default 0 check (partial_count >= 0),
  add column if not exists retry_pending_count integer not null default 0 check (retry_pending_count >= 0),
  add column if not exists dead_letter_count integer not null default 0 check (dead_letter_count >= 0);

alter table public.profile_analytics_refresh_job_items
  drop constraint if exists profile_analytics_refresh_job_items_status_check;

alter table public.profile_analytics_refresh_job_items
  add constraint profile_analytics_refresh_job_items_status_check
  check (status in (
    'pending',
    'processing',
    'retry_pending',
    'synced',
    'partial',
    'no_data',
    'skipped',
    'failed',
    'dead_letter'
  ));

alter table public.profile_analytics_refresh_job_items
  add column if not exists claimed_by text,
  add column if not exists lease_until timestamptz,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists max_attempts integer not null default 5 check (max_attempts between 1 and 10),
  add column if not exists last_error_class text,
  add column if not exists last_attempt_at timestamptz,
  add column if not exists dead_letter_at timestamptz;

create index if not exists profile_analytics_refresh_job_items_claim_v2_idx
  on public.profile_analytics_refresh_job_items (job_id, status, next_attempt_at, lease_until, created_at)
  where status in ('pending', 'processing', 'retry_pending');

create table if not exists public.profile_analytics_refresh_item_events (
  id bigint generated always as identity primary key,
  job_id uuid not null,
  profile_id uuid not null,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  event_type text not null check (event_type in (
    'claimed',
    'lease_recovered',
    'synced',
    'partial',
    'no_data',
    'skipped',
    'retry_scheduled',
    'dead_lettered'
  )),
  attempt_number integer not null check (attempt_number >= 0),
  worker_id text,
  error_class text,
  error_code text,
  error_message text,
  next_attempt_at timestamptz,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default timezone('utc', now()),
  foreign key (job_id, profile_id)
    references public.profile_analytics_refresh_job_items (job_id, profile_id)
    on delete cascade,
  check (char_length(coalesce(worker_id, '')) <= 120),
  check (char_length(coalesce(error_class, '')) <= 80),
  check (char_length(coalesce(error_code, '')) <= 160),
  check (char_length(coalesce(error_message, '')) <= 1200)
);

create index if not exists profile_analytics_refresh_item_events_item_idx
  on public.profile_analytics_refresh_item_events (job_id, profile_id, created_at desc);

alter table public.profile_analytics_refresh_item_events enable row level security;

drop policy if exists profile_analytics_refresh_item_events_select_member
  on public.profile_analytics_refresh_item_events;
create policy profile_analytics_refresh_item_events_select_member
on public.profile_analytics_refresh_item_events for select to authenticated
using (public.is_organization_member(organization_id));

revoke all on table public.profile_analytics_refresh_item_events from public, anon;
grant select on table public.profile_analytics_refresh_item_events to authenticated;
grant select, insert, update, delete on table public.profile_analytics_refresh_item_events to service_role;

create or replace function public.refresh_profile_analytics_refresh_job_status(p_job_id uuid)
returns public.profile_analytics_refresh_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  job_row public.profile_analytics_refresh_jobs%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' and not exists (
    select 1
    from public.profile_analytics_refresh_jobs existing_job
    where existing_job.id = p_job_id
      and public.is_organization_member(existing_job.organization_id)
  ) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  update public.profile_analytics_refresh_jobs job
  set processed_count = stats.processed_count,
      synced_count = stats.synced_count,
      partial_count = stats.partial_count,
      no_data_count = stats.no_data_count,
      skipped_count = stats.skipped_count,
      failed_count = stats.failed_count,
      retry_pending_count = stats.retry_pending_count,
      dead_letter_count = stats.dead_letter_count,
      status = case
        when job.status in ('failed', 'cancelled') then job.status
        when stats.open_count > 0 and stats.processing_count > 0 then 'processing'
        when stats.open_count > 0 then 'pending'
        when stats.failed_count > 0 or stats.partial_count > 0 then 'completed_with_errors'
        else 'completed'
      end,
      claimed_by = case when stats.processing_count > 0 and job.status not in ('failed', 'cancelled') then job.claimed_by else null end,
      lease_until = case when stats.processing_count > 0 and job.status not in ('failed', 'cancelled') then job.lease_until else null end,
      finished_at = case
        when stats.open_count > 0 and job.status not in ('failed', 'cancelled') then null
        else coalesce(job.finished_at, timezone('utc', now()))
      end
  from (
    select
      count(*) filter (where item.status in ('synced', 'partial', 'no_data', 'skipped', 'failed', 'dead_letter'))::integer as processed_count,
      count(*) filter (where item.status = 'synced')::integer as synced_count,
      count(*) filter (where item.status = 'partial')::integer as partial_count,
      count(*) filter (where item.status = 'no_data')::integer as no_data_count,
      count(*) filter (where item.status = 'skipped')::integer as skipped_count,
      count(*) filter (where item.status in ('failed', 'dead_letter'))::integer as failed_count,
      count(*) filter (where item.status = 'retry_pending')::integer as retry_pending_count,
      count(*) filter (where item.status = 'dead_letter')::integer as dead_letter_count,
      count(*) filter (where item.status in ('pending', 'processing', 'retry_pending'))::integer as open_count,
      count(*) filter (where item.status = 'processing')::integer as processing_count
    from public.profile_analytics_refresh_job_items item
    where item.job_id = p_job_id
  ) stats
  where job.id = p_job_id
  returning job.* into job_row;

  return job_row;
end;
$$;

create or replace function public.claim_profile_analytics_refresh_job(
  p_worker_id text,
  p_lease_seconds integer default 300
)
returns table (
  job_id uuid,
  organization_id uuid,
  total_count integer,
  processed_count integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido.';
  end if;
  if p_lease_seconds not between 30 and 1800 then
    raise exception using errcode = '22023', message = 'Lease deve estar entre 30 e 1800 segundos.';
  end if;

  return query
  with candidates as (
    select job.id
    from public.profile_analytics_refresh_jobs job
    where job.status in ('pending', 'processing')
      and (job.lease_until is null or job.lease_until <= timezone('utc', now()) or job.claimed_by = trim(p_worker_id))
      and exists (
        select 1
        from public.profile_analytics_refresh_job_items item
        where item.job_id = job.id
          and item.attempts < item.max_attempts
          and (
            item.status = 'pending'
            or (item.status = 'retry_pending' and coalesce(item.next_attempt_at, timezone('utc', now())) <= timezone('utc', now()))
            or (item.status = 'processing' and coalesce(item.lease_until, '-infinity'::timestamptz) <= timezone('utc', now()))
          )
      )
    order by case job.trigger when 'manual' then 0 when 'connection_sync' then 1 when 'page_view' then 2 else 3 end, job.created_at, job.id
    for update skip locked
    limit 1
  ), claimed as (
    update public.profile_analytics_refresh_jobs job
    set status = 'processing',
        claimed_by = trim(p_worker_id),
        lease_until = timezone('utc', now()) + make_interval(secs => p_lease_seconds),
        started_at = coalesce(job.started_at, timezone('utc', now()))
    from candidates
    where job.id = candidates.id
    returning job.id, job.organization_id, job.total_count, job.processed_count
  )
  select claimed.id, claimed.organization_id, claimed.total_count, claimed.processed_count from claimed;
end;
$$;

create or replace function public.claim_profile_analytics_refresh_job_item(
  p_job_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 300
)
returns table (
  job_id uuid,
  organization_id uuid,
  profile_id uuid,
  zernio_connection_id uuid,
  attempts integer,
  max_attempts integer,
  lease_until timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido.';
  end if;
  if p_lease_seconds not between 30 and 1800 then
    raise exception using errcode = '22023', message = 'Lease deve estar entre 30 e 1800 segundos.';
  end if;

  return query
  with candidates as (
    select item.job_id, item.profile_id, item.status,
      (item.status = 'processing') as recovered
    from public.profile_analytics_refresh_job_items item
    join public.profile_analytics_refresh_jobs job on job.id = item.job_id
    where item.job_id = p_job_id
      and job.status = 'processing'
      and job.claimed_by = trim(p_worker_id)
      and item.attempts < item.max_attempts
      and (
        item.status = 'pending'
        or (item.status = 'retry_pending' and coalesce(item.next_attempt_at, timezone('utc', now())) <= timezone('utc', now()))
        or (item.status = 'processing' and coalesce(item.lease_until, '-infinity'::timestamptz) <= timezone('utc', now()))
      )
    order by item.zernio_connection_id nulls last, item.created_at, item.profile_id
    for update of item skip locked
    limit 1
  ), claimed as (
    update public.profile_analytics_refresh_job_items item
    set status = 'processing',
        attempts = item.attempts + 1,
        claimed_by = trim(p_worker_id),
        lease_until = timezone('utc', now()) + make_interval(secs => p_lease_seconds),
        next_attempt_at = null,
        last_attempt_at = timezone('utc', now()),
        last_error_class = null,
        last_error_code = null,
        last_error_message = null,
        processed_at = null,
        dead_letter_at = null
    from candidates
    where item.job_id = candidates.job_id
      and item.profile_id = candidates.profile_id
    returning item.*, candidates.recovered
  ), event_insert as (
    insert into public.profile_analytics_refresh_item_events (
      job_id, profile_id, organization_id, event_type, attempt_number, worker_id
    )
    select claimed.job_id, claimed.profile_id, claimed.organization_id,
      case when claimed.recovered then 'lease_recovered' else 'claimed' end,
      claimed.attempts, trim(p_worker_id)
    from claimed
    returning id
  )
  select claimed.job_id, claimed.organization_id, claimed.profile_id,
    claimed.zernio_connection_id, claimed.attempts, claimed.max_attempts,
    claimed.lease_until
  from claimed;
end;
$$;

create or replace function public.complete_profile_analytics_refresh_job_item(
  p_job_id uuid,
  p_profile_id uuid,
  p_worker_id text,
  p_outcome text,
  p_error_class text default null,
  p_error_code text default null,
  p_error_message text default null,
  p_retryable boolean default false,
  p_metadata jsonb default '{}'::jsonb
)
returns table (
  status text,
  attempts integer,
  max_attempts integer,
  next_attempt_at timestamptz,
  dead_lettered boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  item_row public.profile_analytics_refresh_job_items%rowtype;
  final_status text;
  retry_at timestamptz;
  safe_message text := left(coalesce(p_error_message, ''), 1200);
  event_name text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;
  if p_outcome not in ('synced', 'partial', 'no_data', 'skipped', 'error') then
    raise exception using errcode = '22023', message = 'Resultado de analytics inválido.';
  end if;
  if jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) <> 'object' then
    raise exception using errcode = '22023', message = 'Metadata de analytics inválida.';
  end if;

  select * into item_row
  from public.profile_analytics_refresh_job_items item
  where item.job_id = p_job_id
    and item.profile_id = p_profile_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Item de analytics não encontrado.';
  end if;
  if item_row.status <> 'processing' or item_row.claimed_by is distinct from trim(p_worker_id) then
    raise exception using errcode = '55000', message = 'Lease do item de analytics não pertence a este worker.';
  end if;

  if p_outcome <> 'error' then
    final_status := p_outcome;
    retry_at := null;
    event_name := p_outcome;
  elsif p_retryable and item_row.attempts < item_row.max_attempts then
    final_status := 'retry_pending';
    retry_at := timezone('utc', now())
      + make_interval(secs => least(3600, (30 * power(2, greatest(item_row.attempts - 1, 0)))::integer + floor(random() * 16)::integer));
    event_name := 'retry_scheduled';
  else
    final_status := 'dead_letter';
    retry_at := null;
    event_name := 'dead_lettered';
  end if;

  update public.profile_analytics_refresh_job_items item
  set status = final_status,
      claimed_by = null,
      lease_until = null,
      next_attempt_at = retry_at,
      last_error_class = case when p_outcome = 'error' then nullif(left(coalesce(p_error_class, 'unknown'), 80), '') else null end,
      last_error_code = case when p_outcome = 'error' then nullif(left(coalesce(p_error_code, 'analytics_refresh_failed'), 160), '') else null end,
      last_error_message = case when p_outcome = 'error' then nullif(safe_message, '') else null end,
      processed_at = case when final_status in ('retry_pending') then null else timezone('utc', now()) end,
      dead_letter_at = case when final_status = 'dead_letter' then timezone('utc', now()) else null end
  where item.job_id = p_job_id
    and item.profile_id = p_profile_id
  returning item.* into item_row;

  insert into public.profile_analytics_refresh_item_events (
    job_id, profile_id, organization_id, event_type, attempt_number, worker_id,
    error_class, error_code, error_message, next_attempt_at, metadata
  ) values (
    item_row.job_id, item_row.profile_id, item_row.organization_id, event_name,
    item_row.attempts, trim(p_worker_id), item_row.last_error_class,
    item_row.last_error_code, item_row.last_error_message, retry_at,
    coalesce(p_metadata, '{}'::jsonb)
  );

  perform public.refresh_profile_analytics_refresh_job_status(p_job_id);

  status := item_row.status;
  attempts := item_row.attempts;
  max_attempts := item_row.max_attempts;
  next_attempt_at := item_row.next_attempt_at;
  dead_lettered := item_row.status = 'dead_letter';
  return next;
end;
$$;

revoke all on function public.claim_profile_analytics_refresh_job_item(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.complete_profile_analytics_refresh_job_item(uuid, uuid, text, text, text, text, text, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.claim_profile_analytics_refresh_job_item(uuid, text, integer) to service_role;
grant execute on function public.complete_profile_analytics_refresh_job_item(uuid, uuid, text, text, text, text, text, boolean, jsonb) to service_role;

notify pgrst, 'reload schema';
