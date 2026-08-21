-- Fila assíncrona para associação em massa de mídias a grupos.
-- Mantém operações pequenas síncronas, mas permite que seleções grandes sejam
-- processadas em chunks pelo worker/cron sem prender a API da galeria.

create table if not exists public.media_group_assignment_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  requested_by uuid references auth.users (id) on delete set null,
  requested_by_email text,
  action text not null check (action in ('add', 'remove', 'replace')),
  group_ids uuid[] not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'completed_with_errors', 'failed', 'cancelled')),
  total_count integer not null default 0 check (total_count >= 0),
  processed_count integer not null default 0 check (processed_count >= 0),
  applied_count integer not null default 0 check (applied_count >= 0),
  skipped_count integer not null default 0 check (skipped_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  claimed_by text,
  lease_until timestamptz,
  last_error_message text,
  created_at timestamptz not null default timezone('utc', now()),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default timezone('utc', now()),
  check (cardinality(group_ids) between 1 and 1000),
  check (char_length(coalesce(requested_by_email, '')) <= 320),
  check (char_length(coalesce(last_error_message, '')) <= 1200)
);

create table if not exists public.media_group_assignment_job_items (
  job_id uuid not null references public.media_group_assignment_jobs (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  media_asset_id uuid not null references public.media_assets (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'processing', 'applied', 'skipped', 'failed')),
  error_message text,
  processed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (job_id, media_asset_id),
  check (char_length(coalesce(error_message, '')) <= 1200)
);

create index if not exists media_group_assignment_jobs_org_status_idx
  on public.media_group_assignment_jobs (organization_id, status, created_at desc);

create index if not exists media_group_assignment_jobs_claim_idx
  on public.media_group_assignment_jobs (status, lease_until, created_at)
  where status in ('pending', 'processing');

create index if not exists media_group_assignment_job_items_job_status_idx
  on public.media_group_assignment_job_items (job_id, status, created_at);

drop trigger if exists media_group_assignment_jobs_set_updated_at on public.media_group_assignment_jobs;
create trigger media_group_assignment_jobs_set_updated_at
before update on public.media_group_assignment_jobs
for each row execute function public.set_updated_at();

drop trigger if exists media_group_assignment_job_items_set_updated_at on public.media_group_assignment_job_items;
create trigger media_group_assignment_job_items_set_updated_at
before update on public.media_group_assignment_job_items
for each row execute function public.set_updated_at();

alter table public.media_group_assignment_jobs enable row level security;
alter table public.media_group_assignment_job_items enable row level security;

create policy media_group_assignment_jobs_select_member
on public.media_group_assignment_jobs for select to authenticated
using (public.is_organization_member(organization_id));

create policy media_group_assignment_job_items_select_member
on public.media_group_assignment_job_items for select to authenticated
using (public.is_organization_member(organization_id));

revoke all on table public.media_group_assignment_jobs, public.media_group_assignment_job_items from anon;
grant select on table public.media_group_assignment_jobs, public.media_group_assignment_job_items to authenticated;
grant select, insert, update, delete on table public.media_group_assignment_jobs, public.media_group_assignment_job_items to service_role;

create or replace function public.update_media_group_assignments_bulk(
  p_organization_id uuid,
  p_media_asset_ids uuid[],
  p_group_ids uuid[],
  p_action text
)
returns table (
  media_asset_id uuid,
  group_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  asset_ids uuid[] := array(select distinct unnest(coalesce(p_media_asset_ids, '{}'::uuid[])));
  target_group_ids uuid[] := array(select distinct unnest(coalesce(p_group_ids, '{}'::uuid[])));
begin
  if not public.has_organization_role(p_organization_id, array['admin', 'operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Ação não permitida';
  end if;

  if cardinality(asset_ids) is null or cardinality(asset_ids) = 0
    or cardinality(target_group_ids) is null or cardinality(target_group_ids) = 0
    or p_action not in ('add', 'remove', 'replace') then
    raise exception using errcode = '22023', message = 'Selecione mídias, grupos e uma operação válida';
  end if;

  if cardinality(asset_ids) > 500 or (cardinality(asset_ids) * cardinality(target_group_ids)) > 5000 then
    raise exception using errcode = '22023', message = 'Esta operação deve ser enfileirada para execução em segundo plano.';
  end if;

  if (select count(*) from public.media_assets asset
      where asset.organization_id = p_organization_id
        and asset.deleted_at is null
        and asset.deletion_requested_at is null
        and asset.id = any(asset_ids)) <> cardinality(asset_ids) then
    raise exception using errcode = '22023', message = 'Uma ou mais mídias são inválidas ou estão em exclusão';
  end if;

  if (select count(*) from public.profile_groups profile_group
      where profile_group.organization_id = p_organization_id
        and profile_group.deleted_at is null
        and profile_group.id = any(target_group_ids)) <> cardinality(target_group_ids) then
    raise exception using errcode = '22023', message = 'Um ou mais grupos são inválidos';
  end if;

  if p_action = 'remove' then
    delete from public.media_group_assignments assignment
    where assignment.organization_id = p_organization_id
      and assignment.media_asset_id = any(asset_ids)
      and assignment.group_id = any(target_group_ids);
  elsif p_action = 'replace' then
    delete from public.media_group_assignments assignment
    where assignment.organization_id = p_organization_id
      and assignment.media_asset_id = any(asset_ids);

    insert into public.media_group_assignments (organization_id, media_asset_id, group_id, assigned_by)
    select p_organization_id, asset_row.asset_id, target_group.group_id, auth.uid()
    from unnest(asset_ids) as asset_row(asset_id)
    cross join unnest(target_group_ids) as target_group(group_id);
  else
    insert into public.media_group_assignments (organization_id, media_asset_id, group_id, assigned_by)
    select p_organization_id, asset_row.asset_id, target_group.group_id, auth.uid()
    from unnest(asset_ids) as asset_row(asset_id)
    cross join unnest(target_group_ids) as target_group(group_id)
    on conflict on constraint media_group_assignments_pkey do nothing;
  end if;

  return query
  select assignment.media_asset_id, assignment.group_id
  from public.media_group_assignments assignment
  where assignment.organization_id = p_organization_id
    and assignment.media_asset_id = any(asset_ids);
end;
$$;

create or replace function public.create_media_group_assignment_job(
  p_organization_id uuid,
  p_media_asset_ids uuid[],
  p_group_ids uuid[],
  p_action text
)
returns table (
  job_id uuid,
  total_count integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  asset_ids uuid[] := array(select distinct unnest(coalesce(p_media_asset_ids, '{}'::uuid[])));
  target_group_ids uuid[] := array(select distinct unnest(coalesce(p_group_ids, '{}'::uuid[])));
  new_job public.media_group_assignment_jobs%rowtype;
  request_time timestamptz := timezone('utc', now());
begin
  if coalesce(auth.role(), '') <> 'service_role' and not public.has_organization_role(p_organization_id, array['admin', 'operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  if coalesce(array_length(asset_ids, 1), 0) = 0
    or coalesce(array_length(target_group_ids, 1), 0) = 0
    or p_action not in ('add', 'remove', 'replace') then
    raise exception using errcode = '22023', message = 'Selecione mídias, grupos e uma operação válida.';
  end if;

  if array_length(asset_ids, 1) > 50000 then
    raise exception using errcode = '22023', message = 'Selecione até 50000 mídias por fila de organização em grupos.';
  end if;

  if array_length(target_group_ids, 1) > 1000 then
    raise exception using errcode = '22023', message = 'Selecione até 1000 grupos por fila de organização.';
  end if;

  if (select count(*) from public.media_assets asset
      where asset.organization_id = p_organization_id
        and asset.deleted_at is null
        and asset.deletion_requested_at is null
        and asset.id = any(asset_ids)) <> cardinality(asset_ids) then
    raise exception using errcode = '22023', message = 'Uma ou mais mídias são inválidas ou estão em exclusão.';
  end if;

  if (select count(*) from public.profile_groups profile_group
      where profile_group.organization_id = p_organization_id
        and profile_group.deleted_at is null
        and profile_group.id = any(target_group_ids)) <> cardinality(target_group_ids) then
    raise exception using errcode = '22023', message = 'Um ou mais grupos são inválidos.';
  end if;

  insert into public.media_group_assignment_jobs (organization_id, requested_by, requested_by_email, action, group_ids, status)
  values (p_organization_id, auth.uid(), nullif(auth.jwt() ->> 'email', ''), p_action, target_group_ids, 'pending')
  returning * into new_job;

  insert into public.media_group_assignment_job_items (job_id, organization_id, media_asset_id)
  select new_job.id, p_organization_id, asset_row.asset_id
  from unnest(asset_ids) as asset_row(asset_id);

  update public.media_group_assignment_jobs job
  set total_count = (
    select count(*)::integer
    from public.media_group_assignment_job_items item
    where item.job_id = new_job.id
  ),
  status = case when exists (select 1 from public.media_group_assignment_job_items item where item.job_id = new_job.id) then 'pending' else 'completed' end,
  finished_at = case when exists (select 1 from public.media_group_assignment_job_items item where item.job_id = new_job.id) then null else request_time end
  where job.id = new_job.id
  returning job.* into new_job;

  job_id := new_job.id;
  total_count := new_job.total_count;
  return next;
end;
$$;

create or replace function public.claim_media_group_assignment_job(
  p_worker_id text,
  p_lease_seconds integer default 120
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
  if p_lease_seconds not between 30 and 900 then
    raise exception using errcode = '22023', message = 'Lease deve estar entre 30 e 900 segundos.';
  end if;

  return query
  with candidates as (
    select job.id
    from public.media_group_assignment_jobs job
    where job.status in ('pending', 'processing')
      and (job.lease_until is null or job.lease_until <= timezone('utc', now()) or job.claimed_by = trim(p_worker_id))
      and not exists (
        select 1
        from public.media_group_assignment_jobs active_job
        where active_job.organization_id = job.organization_id
          and active_job.id <> job.id
          and active_job.status = 'processing'
          and active_job.lease_until > timezone('utc', now())
      )
    order by job.created_at, job.id
    for update skip locked
    limit 1
  ), claimed as (
    update public.media_group_assignment_jobs job
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

create or replace function public.refresh_media_group_assignment_job_status(p_job_id uuid)
returns public.media_group_assignment_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  job_row public.media_group_assignment_jobs%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' and not exists (
    select 1
    from public.media_group_assignment_jobs existing_job
    where existing_job.id = p_job_id
      and public.is_organization_member(existing_job.organization_id)
  ) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  update public.media_group_assignment_jobs job
  set processed_count = stats.processed_count,
      applied_count = stats.applied_count,
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
      count(*) filter (where item.status in ('applied', 'skipped', 'failed'))::integer as processed_count,
      count(*) filter (where item.status = 'applied')::integer as applied_count,
      count(*) filter (where item.status = 'skipped')::integer as skipped_count,
      count(*) filter (where item.status = 'failed')::integer as failed_count,
      count(*) filter (where item.status in ('pending', 'processing'))::integer as pending_count
    from public.media_group_assignment_job_items item
    where item.job_id = p_job_id
  ) stats
  where job.id = p_job_id
  returning job.* into job_row;

  return job_row;
end;
$$;

create or replace function public.process_media_group_assignment_job_chunk(
  p_job_id uuid,
  p_chunk_size integer default 500
)
returns table (
  job_id uuid,
  processed integer,
  applied integer,
  skipped integer,
  failed integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  job_row public.media_group_assignment_jobs%rowtype;
  chunk_asset_ids uuid[];
  valid_asset_ids uuid[];
  skipped_asset_ids uuid[];
  actor_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  if p_chunk_size not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'Chunk deve estar entre 1 e 1000 mídias.';
  end if;

  select * into job_row
  from public.media_group_assignment_jobs job
  where job.id = p_job_id
    and job.status in ('pending', 'processing')
  for update;

  if not found then
    return;
  end if;

  actor_id := job_row.requested_by;
  if actor_id is null and job_row.action in ('add', 'replace') then
    raise exception using errcode = '23502', message = 'Job sem usuário solicitante não pode criar associações.';
  end if;

  select coalesce(array_agg(item.media_asset_id order by item.created_at, item.media_asset_id), '{}'::uuid[])
  into chunk_asset_ids
  from (
    select item.media_asset_id, item.created_at
    from public.media_group_assignment_job_items item
    where item.job_id = p_job_id
      and item.status in ('pending', 'processing')
    order by item.created_at, item.media_asset_id
    limit p_chunk_size
    for update skip locked
  ) item;

  if coalesce(array_length(chunk_asset_ids, 1), 0) = 0 then
    perform public.refresh_media_group_assignment_job_status(p_job_id);
    return query select p_job_id, 0, 0, 0, 0;
    return;
  end if;

  update public.media_group_assignment_job_items item
  set status = 'processing',
      error_message = null
  where item.job_id = p_job_id
    and item.media_asset_id = any(chunk_asset_ids);

  select coalesce(array_agg(asset.id order by asset.id), '{}'::uuid[])
  into valid_asset_ids
  from public.media_assets asset
  where asset.organization_id = job_row.organization_id
    and asset.deleted_at is null
    and asset.deletion_requested_at is null
    and asset.id = any(chunk_asset_ids);

  select coalesce(array_agg(asset_id order by asset_id), '{}'::uuid[])
  into skipped_asset_ids
  from unnest(chunk_asset_ids) as asset_row(asset_id)
  where not asset_row.asset_id = any(valid_asset_ids);

  if coalesce(array_length(valid_asset_ids, 1), 0) > 0 then
    if job_row.action = 'remove' then
      delete from public.media_group_assignments assignment
      where assignment.organization_id = job_row.organization_id
        and assignment.media_asset_id = any(valid_asset_ids)
        and assignment.group_id = any(job_row.group_ids);
    elsif job_row.action = 'replace' then
      delete from public.media_group_assignments assignment
      where assignment.organization_id = job_row.organization_id
        and assignment.media_asset_id = any(valid_asset_ids);

      insert into public.media_group_assignments (organization_id, media_asset_id, group_id, assigned_by)
      select job_row.organization_id, asset_row.asset_id, target_group.group_id, actor_id
      from unnest(valid_asset_ids) as asset_row(asset_id)
      cross join unnest(job_row.group_ids) as target_group(group_id);
    else
      insert into public.media_group_assignments (organization_id, media_asset_id, group_id, assigned_by)
      select job_row.organization_id, asset_row.asset_id, target_group.group_id, actor_id
      from unnest(valid_asset_ids) as asset_row(asset_id)
      cross join unnest(job_row.group_ids) as target_group(group_id)
      on conflict on constraint media_group_assignments_pkey do nothing;
    end if;

    update public.media_group_assignment_job_items item
    set status = 'applied',
        processed_at = timezone('utc', now()),
        error_message = null
    where item.job_id = p_job_id
      and item.media_asset_id = any(valid_asset_ids);
  end if;

  if coalesce(array_length(skipped_asset_ids, 1), 0) > 0 then
    update public.media_group_assignment_job_items item
    set status = 'skipped',
        processed_at = timezone('utc', now()),
        error_message = 'Mídia já removida ou em exclusão.'
    where item.job_id = p_job_id
      and item.media_asset_id = any(skipped_asset_ids);
  end if;

  perform public.refresh_media_group_assignment_job_status(p_job_id);

  return query select
    p_job_id,
    cardinality(chunk_asset_ids)::integer,
    cardinality(valid_asset_ids)::integer,
    cardinality(skipped_asset_ids)::integer,
    0;
end;
$$;

revoke all on function public.update_media_group_assignments_bulk(uuid, uuid[], uuid[], text) from public, anon;
revoke all on function public.create_media_group_assignment_job(uuid, uuid[], uuid[], text) from public, anon;
revoke all on function public.claim_media_group_assignment_job(text, integer) from public, anon, authenticated;
revoke all on function public.refresh_media_group_assignment_job_status(uuid) from public, anon;
revoke all on function public.process_media_group_assignment_job_chunk(uuid, integer) from public, anon, authenticated;
grant execute on function public.update_media_group_assignments_bulk(uuid, uuid[], uuid[], text) to authenticated, service_role;
grant execute on function public.create_media_group_assignment_job(uuid, uuid[], uuid[], text) to authenticated;
grant execute on function public.claim_media_group_assignment_job(text, integer) to service_role;
grant execute on function public.refresh_media_group_assignment_job_status(uuid) to authenticated, service_role;
grant execute on function public.process_media_group_assignment_job_chunk(uuid, integer) to service_role;
