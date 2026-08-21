-- Athena Scheduler: fila protegida para refresh de analytics de perfis.
-- Evita chamadas repetidas à Zernio em page views e protege o botão manual contra spam.

alter table public.publication_worker_settings
  drop constraint if exists publication_worker_settings_worker_kind_check;

alter table public.publication_worker_settings
  add constraint publication_worker_settings_worker_kind_check
  check (worker_kind in ('publication', 'publication_planner', 'media_deletion', 'media_processing', 'profile_analytics'));

alter table public.publication_worker_heartbeats
  drop constraint if exists publication_worker_heartbeats_worker_kind_check;

alter table public.publication_worker_heartbeats
  add constraint publication_worker_heartbeats_worker_kind_check
  check (worker_kind in ('publication', 'publication_planner', 'media_deletion', 'media_processing', 'profile_analytics'));

create table if not exists public.profile_analytics_refresh_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  requested_by uuid references auth.users (id) on delete set null,
  requested_by_email text,
  trigger text not null default 'manual' check (trigger in ('page_view', 'manual', 'connection_sync', 'worker')),
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'completed_with_errors', 'failed', 'cancelled')),
  total_count integer not null default 0 check (total_count >= 0),
  processed_count integer not null default 0 check (processed_count >= 0),
  synced_count integer not null default 0 check (synced_count >= 0),
  no_data_count integer not null default 0 check (no_data_count >= 0),
  skipped_count integer not null default 0 check (skipped_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  stale_after_minutes integer not null default 60 check (stale_after_minutes between 5 and 10080),
  claimed_by text,
  lease_until timestamptz,
  last_error_message text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default timezone('utc', now()),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default timezone('utc', now()),
  check (char_length(coalesce(requested_by_email, '')) <= 320),
  check (char_length(coalesce(last_error_message, '')) <= 1200)
);

create table if not exists public.profile_analytics_refresh_job_items (
  job_id uuid not null references public.profile_analytics_refresh_jobs (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  profile_id uuid not null references public.instagram_profiles (id) on delete cascade,
  zernio_connection_id uuid references public.zernio_connections (id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'synced', 'no_data', 'skipped', 'failed')),
  attempts integer not null default 0 check (attempts >= 0 and attempts <= 10),
  last_error_code text,
  last_error_message text,
  processed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (job_id, profile_id),
  check (char_length(coalesce(last_error_message, '')) <= 1200)
);

create unique index if not exists profile_analytics_refresh_jobs_one_active_org_idx
  on public.profile_analytics_refresh_jobs (organization_id)
  where status in ('pending', 'processing');

create index if not exists profile_analytics_refresh_jobs_org_status_idx
  on public.profile_analytics_refresh_jobs (organization_id, status, created_at desc);

create index if not exists profile_analytics_refresh_jobs_claim_idx
  on public.profile_analytics_refresh_jobs (status, lease_until, created_at)
  where status in ('pending', 'processing');

create index if not exists profile_analytics_refresh_job_items_job_status_idx
  on public.profile_analytics_refresh_job_items (job_id, status, created_at);

create index if not exists profile_analytics_refresh_job_items_connection_status_idx
  on public.profile_analytics_refresh_job_items (organization_id, zernio_connection_id, status, created_at)
  where status in ('pending', 'processing');

drop trigger if exists profile_analytics_refresh_jobs_set_updated_at on public.profile_analytics_refresh_jobs;
create trigger profile_analytics_refresh_jobs_set_updated_at
before update on public.profile_analytics_refresh_jobs
for each row execute function public.set_updated_at();

drop trigger if exists profile_analytics_refresh_job_items_set_updated_at on public.profile_analytics_refresh_job_items;
create trigger profile_analytics_refresh_job_items_set_updated_at
before update on public.profile_analytics_refresh_job_items
for each row execute function public.set_updated_at();

alter table public.profile_analytics_refresh_jobs enable row level security;
alter table public.profile_analytics_refresh_job_items enable row level security;

create policy profile_analytics_refresh_jobs_select_member
on public.profile_analytics_refresh_jobs for select to authenticated
using (public.is_organization_member(organization_id));

create policy profile_analytics_refresh_job_items_select_member
on public.profile_analytics_refresh_job_items for select to authenticated
using (public.is_organization_member(organization_id));

revoke all on table public.profile_analytics_refresh_jobs, public.profile_analytics_refresh_job_items from anon;
grant select on table public.profile_analytics_refresh_jobs, public.profile_analytics_refresh_job_items to authenticated;
grant select, insert, update, delete on table public.profile_analytics_refresh_jobs, public.profile_analytics_refresh_job_items to service_role;

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
      no_data_count = stats.no_data_count,
      skipped_count = stats.skipped_count,
      failed_count = stats.failed_count,
      status = case
        when job.status in ('failed', 'cancelled') then job.status
        when stats.pending_count > 0 then job.status
        when stats.failed_count > 0 then 'completed_with_errors'
        else 'completed'
      end,
      claimed_by = case when stats.pending_count > 0 and job.status not in ('failed', 'cancelled') then job.claimed_by else null end,
      lease_until = case when stats.pending_count > 0 and job.status not in ('failed', 'cancelled') then job.lease_until else null end,
      finished_at = case when stats.pending_count > 0 and job.status not in ('failed', 'cancelled') then job.finished_at else coalesce(job.finished_at, timezone('utc', now())) end
  from (
    select
      count(*) filter (where item.status in ('synced', 'no_data', 'skipped', 'failed'))::integer as processed_count,
      count(*) filter (where item.status = 'synced')::integer as synced_count,
      count(*) filter (where item.status = 'no_data')::integer as no_data_count,
      count(*) filter (where item.status = 'skipped')::integer as skipped_count,
      count(*) filter (where item.status = 'failed')::integer as failed_count,
      count(*) filter (where item.status in ('pending', 'processing'))::integer as pending_count
    from public.profile_analytics_refresh_job_items item
    where item.job_id = p_job_id
  ) stats
  where job.id = p_job_id
  returning job.* into job_row;

  return job_row;
end;
$$;

create or replace function public.create_profile_analytics_refresh_job(
  p_organization_id uuid,
  p_trigger text default 'manual',
  p_profile_ids uuid[] default null,
  p_stale_after_minutes integer default 60,
  p_manual_cooldown_seconds integer default 300
)
returns table (
  job_id uuid,
  status text,
  total_count integer,
  reused boolean,
  reason text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_trigger text := coalesce(nullif(trim(p_trigger), ''), 'manual');
  stale_minutes integer := least(greatest(coalesce(p_stale_after_minutes, 60), 5), 10080);
  cooldown_seconds integer := least(greatest(coalesce(p_manual_cooldown_seconds, 300), 30), 3600);
  active_job public.profile_analytics_refresh_jobs%rowtype;
  recent_job public.profile_analytics_refresh_jobs%rowtype;
  new_job public.profile_analytics_refresh_jobs%rowtype;
  profile_ids uuid[] := case when p_profile_ids is null then null else array(select distinct unnest(p_profile_ids)) end;
begin
  if normalized_trigger not in ('page_view', 'manual', 'connection_sync', 'worker') then
    raise exception using errcode = '22023', message = 'Trigger de refresh inválido.';
  end if;

  if coalesce(auth.role(), '') <> 'service_role' then
    if not public.is_organization_member(p_organization_id) then
      raise exception using errcode = '42501', message = 'Ação não permitida.';
    end if;
    if normalized_trigger in ('manual', 'connection_sync') and not public.has_organization_role(p_organization_id, array['admin', 'operator']::public.organization_role[]) then
      raise exception using errcode = '42501', message = 'Ação não permitida.';
    end if;
  end if;

  select * into active_job
  from public.profile_analytics_refresh_jobs job
  where job.organization_id = p_organization_id
    and job.status in ('pending', 'processing')
    and (job.lease_until is null or job.lease_until > timezone('utc', now()) or job.status = 'pending')
  order by job.created_at desc
  limit 1;

  if found then
    job_id := active_job.id;
    status := active_job.status;
    total_count := active_job.total_count;
    reused := true;
    reason := 'active_job';
    return next;
    return;
  end if;

  if normalized_trigger = 'manual' then
    select * into recent_job
    from public.profile_analytics_refresh_jobs job
    where job.organization_id = p_organization_id
      and job.trigger = 'manual'
      and job.created_at > timezone('utc', now()) - make_interval(secs => cooldown_seconds)
    order by job.created_at desc
    limit 1;

    if found then
      job_id := recent_job.id;
      status := recent_job.status;
      total_count := recent_job.total_count;
      reused := true;
      reason := 'manual_cooldown';
      return next;
      return;
    end if;
  end if;

  insert into public.profile_analytics_refresh_jobs (
    organization_id,
    requested_by,
    requested_by_email,
    trigger,
    status,
    stale_after_minutes,
    metadata
  ) values (
    p_organization_id,
    case when coalesce(auth.role(), '') = 'service_role' then null else auth.uid() end,
    case when coalesce(auth.role(), '') = 'service_role' then null else nullif(auth.jwt() ->> 'email', '') end,
    normalized_trigger,
    'pending',
    stale_minutes,
    jsonb_build_object('profileIdsRequested', coalesce(cardinality(profile_ids), 0))
  )
  returning * into new_job;

  insert into public.profile_analytics_refresh_job_items (job_id, organization_id, profile_id, zernio_connection_id)
  select new_job.id, p_organization_id, profile.id, profile.zernio_connection_id
  from public.instagram_profiles profile
  left join lateral (
    select snapshot.synced_at, snapshot.sync_status
    from public.profile_analytics_snapshots snapshot
    where snapshot.organization_id = profile.organization_id
      and snapshot.profile_id = profile.id
      and snapshot.deleted_at is null
    order by snapshot.period_end desc, snapshot.synced_at desc nulls last, snapshot.updated_at desc
    limit 1
  ) latest_snapshot on true
  where profile.organization_id = p_organization_id
    and profile.provider = 'zernio'
    and profile.deleted_at is null
    and profile.zernio_account_id is not null
    and (profile_ids is null or profile.id = any(profile_ids))
    and (
      latest_snapshot.synced_at is null
      or latest_snapshot.sync_status <> 'synced'
      or latest_snapshot.synced_at < timezone('utc', now()) - make_interval(mins => stale_minutes)
    )
  order by profile.zernio_connection_id nulls last, profile.created_at;

  update public.profile_analytics_refresh_jobs job
  set total_count = (
        select count(*)::integer
        from public.profile_analytics_refresh_job_items item
        where item.job_id = new_job.id
      ),
      status = case when exists (select 1 from public.profile_analytics_refresh_job_items item where item.job_id = new_job.id) then 'pending' else 'completed' end,
      finished_at = case when exists (select 1 from public.profile_analytics_refresh_job_items item where item.job_id = new_job.id) then null else timezone('utc', now()) end
  where job.id = new_job.id
  returning job.* into new_job;

  job_id := new_job.id;
  status := new_job.status;
  total_count := new_job.total_count;
  reused := false;
  reason := case when new_job.total_count = 0 then 'nothing_stale' else 'created' end;
  return next;
exception when unique_violation then
  select * into active_job
  from public.profile_analytics_refresh_jobs job
  where job.organization_id = p_organization_id
    and job.status in ('pending', 'processing')
  order by job.created_at desc
  limit 1;

  if found then
    job_id := active_job.id;
    status := active_job.status;
    total_count := active_job.total_count;
    reused := true;
    reason := 'active_job';
    return next;
    return;
  end if;

  raise;
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

revoke all on function public.create_profile_analytics_refresh_job(uuid, text, uuid[], integer, integer) from public, anon;
revoke all on function public.claim_profile_analytics_refresh_job(text, integer) from public, anon;
revoke all on function public.refresh_profile_analytics_refresh_job_status(uuid) from public, anon;

grant execute on function public.create_profile_analytics_refresh_job(uuid, text, uuid[], integer, integer) to authenticated, service_role;
grant execute on function public.claim_profile_analytics_refresh_job(text, integer) to service_role;
grant execute on function public.refresh_profile_analytics_refresh_job_status(uuid) to authenticated, service_role;
