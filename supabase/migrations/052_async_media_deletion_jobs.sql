-- Fila assíncrona para exclusões grandes de mídia. A marcação
-- deletion_requested_at esconde a mídia do compositor/galeria antes do worker
-- concluir os chunks, evitando novas publicações com mídia em exclusão.

alter table public.media_assets
  add column if not exists deletion_requested_at timestamptz,
  add column if not exists deletion_requested_by uuid references auth.users (id) on delete set null;

create index if not exists media_assets_org_deletion_requested_idx
  on public.media_assets (organization_id, deletion_requested_at)
  where deleted_at is null and deletion_requested_at is not null;

create or replace function public.delete_media_assets_and_remove_publication_items(
  p_organization_id uuid,
  p_media_asset_ids uuid[]
)
returns table (
  media_asset_id uuid,
  storage_path text,
  thumbnail_storage_path text,
  affected_item_ids uuid[],
  affected_batch_ids uuid[]
)
language plpgsql
security definer
set search_path = public
as $$
declare
  asset_ids uuid[] := array(select distinct unnest(coalesce(p_media_asset_ids, '{}'::uuid[])));
  asset_row public.media_assets%rowtype;
  item_row public.publication_items%rowtype;
  updated_item public.publication_items%rowtype;
  item_ids uuid[];
  batch_ids uuid[];
  batch_id uuid;
  deleted_at_value timestamptz := timezone('utc', now());
begin
  if coalesce(auth.role(), '') <> 'service_role' and not public.has_organization_role(p_organization_id, array['admin', 'operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  if coalesce(array_length(asset_ids, 1), 0) = 0 or array_length(asset_ids, 1) > 100 then
    raise exception using errcode = '22023', message = 'Selecione entre 1 e 100 mídias para excluir.';
  end if;

  for asset_row in
    select *
    from public.media_assets
    where organization_id = p_organization_id
      and deleted_at is null
      and id = any(asset_ids)
    for update
  loop
    item_ids := '{}'::uuid[];
    batch_ids := '{}'::uuid[];

    for item_row in
      select item.*
      from public.publication_items item
      where item.organization_id = p_organization_id
        and item.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed')
        and exists (
          select 1
          from public.publication_item_media link
          where link.publication_item_id = item.id
            and link.organization_id = item.organization_id
            and link.media_asset_id = asset_row.id
        )
      for update of item
    loop
      update public.publication_items
      set status = 'removed',
          cancelled_at = deleted_at_value,
          next_attempt_at = null,
          lease_until = null,
          claimed_by = null,
          creation_id = null,
          last_error_code = 'media_deleted',
          last_error_message = 'Mídia apagada.'
      where id = item_row.id
      returning * into updated_item;

      perform public.log_publication_item_event(
        updated_item.id,
        'cancelled',
        item_row.status,
        updated_item.status,
        auth.uid(),
        coalesce(auth.jwt() ->> 'email', 'worker:media-deletion'),
        'media_deleted',
        'Mídia apagada.',
        jsonb_build_object(
          'action', 'media_deleted_from_gallery',
          'media_asset_id', asset_row.id,
          'media_original_name', asset_row.original_name
        )
      );

      item_ids := array_append(item_ids, updated_item.id);
      if not updated_item.batch_id = any(batch_ids) then
        batch_ids := array_append(batch_ids, updated_item.batch_id);
      end if;
    end loop;

    delete from public.media_group_assignments assignment
    where assignment.organization_id = p_organization_id
      and assignment.media_asset_id = asset_row.id;

    update public.media_assets
    set deleted_at = deleted_at_value,
        deletion_requested_at = null,
        deletion_requested_by = null,
        status = 'deleted',
        processing_error = null
    where id = asset_row.id
      and organization_id = p_organization_id;

    foreach batch_id in array batch_ids
    loop
      perform public.sync_publication_batch_status(batch_id);
    end loop;

    media_asset_id := asset_row.id;
    storage_path := asset_row.storage_path;
    thumbnail_storage_path := asset_row.thumbnail_storage_path;
    affected_item_ids := item_ids;
    affected_batch_ids := batch_ids;
    return next;
  end loop;
end;
$$;

create table if not exists public.media_deletion_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  requested_by uuid references auth.users (id) on delete set null,
  requested_by_email text,
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'completed_with_errors', 'failed', 'cancelled')),
  total_count integer not null default 0 check (total_count >= 0),
  processed_count integer not null default 0 check (processed_count >= 0),
  deleted_count integer not null default 0 check (deleted_count >= 0),
  affected_item_count integer not null default 0 check (affected_item_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  claimed_by text,
  lease_until timestamptz,
  last_error_message text,
  created_at timestamptz not null default timezone('utc', now()),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default timezone('utc', now()),
  check (char_length(coalesce(requested_by_email, '')) <= 320),
  check (char_length(coalesce(last_error_message, '')) <= 1200)
);

create table if not exists public.media_deletion_job_items (
  job_id uuid not null references public.media_deletion_jobs (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  media_asset_id uuid not null references public.media_assets (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'processing', 'deleted', 'skipped', 'failed')),
  affected_item_ids uuid[] not null default '{}'::uuid[],
  affected_batch_ids uuid[] not null default '{}'::uuid[],
  error_message text,
  processed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (job_id, media_asset_id),
  check (char_length(coalesce(error_message, '')) <= 1200)
);

create index if not exists media_deletion_jobs_org_status_idx
  on public.media_deletion_jobs (organization_id, status, created_at desc);

create index if not exists media_deletion_jobs_claim_idx
  on public.media_deletion_jobs (status, lease_until, created_at)
  where status in ('pending', 'processing');

create index if not exists media_deletion_job_items_job_status_idx
  on public.media_deletion_job_items (job_id, status, created_at);

drop trigger if exists media_deletion_jobs_set_updated_at on public.media_deletion_jobs;
create trigger media_deletion_jobs_set_updated_at
before update on public.media_deletion_jobs
for each row execute function public.set_updated_at();

drop trigger if exists media_deletion_job_items_set_updated_at on public.media_deletion_job_items;
create trigger media_deletion_job_items_set_updated_at
before update on public.media_deletion_job_items
for each row execute function public.set_updated_at();

alter table public.media_deletion_jobs enable row level security;
alter table public.media_deletion_job_items enable row level security;

create policy media_deletion_jobs_select_member
on public.media_deletion_jobs for select to authenticated
using (public.is_organization_member(organization_id));

create policy media_deletion_job_items_select_member
on public.media_deletion_job_items for select to authenticated
using (public.is_organization_member(organization_id));

revoke all on table public.media_deletion_jobs, public.media_deletion_job_items from anon;
grant select on table public.media_deletion_jobs, public.media_deletion_job_items to authenticated;
grant select, insert, update, delete on table public.media_deletion_jobs, public.media_deletion_job_items to service_role;

create or replace function public.create_media_deletion_job(
  p_organization_id uuid,
  p_media_asset_ids uuid[]
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
  new_job public.media_deletion_jobs%rowtype;
  request_time timestamptz := timezone('utc', now());
begin
  if coalesce(auth.role(), '') <> 'service_role' and not public.has_organization_role(p_organization_id, array['admin', 'operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  if coalesce(array_length(asset_ids, 1), 0) = 0 then
    raise exception using errcode = '22023', message = 'Selecione ao menos uma mídia para excluir.';
  end if;

  insert into public.media_deletion_jobs (organization_id, requested_by, requested_by_email, status)
  values (p_organization_id, auth.uid(), nullif(auth.jwt() ->> 'email', ''), 'pending')
  returning * into new_job;

  insert into public.media_deletion_job_items (job_id, organization_id, media_asset_id)
  select new_job.id, p_organization_id, asset.id
  from public.media_assets asset
  where asset.organization_id = p_organization_id
    and asset.deleted_at is null
    and asset.deletion_requested_at is null
    and asset.id = any(asset_ids);

  update public.media_assets asset
  set deletion_requested_at = request_time,
      deletion_requested_by = auth.uid()
  where asset.organization_id = p_organization_id
    and asset.deleted_at is null
    and asset.deletion_requested_at is null
    and asset.id in (
      select item.media_asset_id
      from public.media_deletion_job_items item
      where item.job_id = new_job.id
    );

  update public.media_deletion_jobs job
  set total_count = (
    select count(*)::integer
    from public.media_deletion_job_items item
    where item.job_id = new_job.id
  ),
  status = case when exists (select 1 from public.media_deletion_job_items item where item.job_id = new_job.id) then 'pending' else 'completed' end,
  finished_at = case when exists (select 1 from public.media_deletion_job_items item where item.job_id = new_job.id) then null else request_time end
  where job.id = new_job.id
  returning job.* into new_job;

  job_id := new_job.id;
  total_count := new_job.total_count;
  return next;
end;
$$;

create or replace function public.claim_media_deletion_job(
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
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido';
  end if;
  if p_lease_seconds not between 30 and 900 then
    raise exception using errcode = '22023', message = 'Lease deve estar entre 30 e 900 segundos';
  end if;

  return query
  with candidates as (
    select job.id
    from public.media_deletion_jobs job
    where job.status in ('pending', 'processing')
      and (job.lease_until is null or job.lease_until <= timezone('utc', now()) or job.claimed_by = trim(p_worker_id))
      and not exists (
        select 1
        from public.media_deletion_jobs active_job
        where active_job.organization_id = job.organization_id
          and active_job.id <> job.id
          and active_job.status = 'processing'
          and active_job.lease_until > timezone('utc', now())
      )
    order by job.created_at, job.id
    for update skip locked
    limit 1
  ), claimed as (
    update public.media_deletion_jobs job
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

create or replace function public.create_gallery_filter_media_deletion_job(
  p_organization_id uuid,
  p_situation_filter text default 'all',
  p_type_filter text default 'all',
  p_group_id uuid default null,
  p_ungrouped boolean default false,
  p_search text default ''
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
  new_job public.media_deletion_jobs%rowtype;
  request_time timestamptz := timezone('utc', now());
begin
  if coalesce(auth.role(), '') <> 'service_role' and not public.has_organization_role(p_organization_id, array['admin', 'operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  insert into public.media_deletion_jobs (organization_id, requested_by, requested_by_email, status)
  values (p_organization_id, auth.uid(), nullif(auth.jwt() ->> 'email', ''), 'pending')
  returning * into new_job;

  insert into public.media_deletion_job_items (job_id, organization_id, media_asset_id)
  select new_job.id, p_organization_id, ids.media_asset_id
  from public.list_gallery_media_ids_for_deletion(
    p_organization_id,
    p_situation_filter,
    p_type_filter,
    p_group_id,
    p_ungrouped,
    p_search,
    50000
  ) ids;

  update public.media_assets asset
  set deletion_requested_at = request_time,
      deletion_requested_by = auth.uid()
  where asset.organization_id = p_organization_id
    and asset.deleted_at is null
    and asset.deletion_requested_at is null
    and asset.id in (
      select item.media_asset_id
      from public.media_deletion_job_items item
      where item.job_id = new_job.id
    );

  update public.media_deletion_jobs job
  set total_count = (
    select count(*)::integer
    from public.media_deletion_job_items item
    where item.job_id = new_job.id
  ),
  status = case when exists (select 1 from public.media_deletion_job_items item where item.job_id = new_job.id) then 'pending' else 'completed' end,
  finished_at = case when exists (select 1 from public.media_deletion_job_items item where item.job_id = new_job.id) then null else request_time end
  where job.id = new_job.id
  returning job.* into new_job;

  job_id := new_job.id;
  total_count := new_job.total_count;
  return next;
end;
$$;

create or replace function public.refresh_media_deletion_job_status(p_job_id uuid)
returns public.media_deletion_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  job_row public.media_deletion_jobs%rowtype;
begin
  update public.media_deletion_jobs job
  set processed_count = stats.processed_count,
      deleted_count = stats.deleted_count,
      failed_count = stats.failed_count,
      affected_item_count = stats.affected_item_count,
      status = case
        when stats.pending_count > 0 then job.status
        when stats.failed_count > 0 then 'completed_with_errors'
        else 'completed'
      end,
      claimed_by = case when stats.pending_count > 0 then job.claimed_by else null end,
      lease_until = case when stats.pending_count > 0 then job.lease_until else null end,
      finished_at = case when stats.pending_count > 0 then job.finished_at else coalesce(job.finished_at, timezone('utc', now())) end
  from (
    select
      count(*) filter (where item.status in ('deleted', 'skipped', 'failed'))::integer as processed_count,
      count(*) filter (where item.status = 'deleted')::integer as deleted_count,
      count(*) filter (where item.status = 'failed')::integer as failed_count,
      count(*) filter (where item.status in ('pending', 'processing'))::integer as pending_count,
      coalesce(sum(cardinality(item.affected_item_ids)), 0)::integer as affected_item_count
    from public.media_deletion_job_items item
    where item.job_id = p_job_id
  ) stats
  where job.id = p_job_id
  returning job.* into job_row;

  return job_row;
end;
$$;

revoke all on function public.create_media_deletion_job(uuid, uuid[]) from public, anon;
revoke all on function public.create_gallery_filter_media_deletion_job(uuid, text, text, uuid, boolean, text) from public, anon;
revoke all on function public.claim_media_deletion_job(text, integer) from public, anon, authenticated;
revoke all on function public.refresh_media_deletion_job_status(uuid) from public, anon, authenticated;
grant execute on function public.create_media_deletion_job(uuid, uuid[]) to authenticated;
grant execute on function public.create_gallery_filter_media_deletion_job(uuid, text, text, uuid, boolean, text) to authenticated;
grant execute on function public.claim_media_deletion_job(text, integer) to service_role;
grant execute on function public.refresh_media_deletion_job_status(uuid) to service_role;

create or replace function public.list_composer_media_ids(
  p_organization_id uuid,
  p_usage_filter text,
  p_group_id uuid default null,
  p_ungrouped boolean default false,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null,
  p_limit integer default 31
)
returns table (
  media_asset_id uuid,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with media_state as (
    select
      asset.id,
      asset.created_at,
      exists (
        select 1
        from public.publication_item_media link
        join public.publication_items item
          on item.id = link.publication_item_id
         and item.organization_id = link.organization_id
        where link.organization_id = p_organization_id
          and link.media_asset_id = asset.id
          and public.media_item_is_active_schedule(item.status, item.execute_at, item.published_at)
      ) as is_scheduled,
      (asset.first_published_at is not null) as is_published
    from public.media_assets asset
    where asset.organization_id = p_organization_id
      and asset.deleted_at is null
      and asset.deletion_requested_at is null
      and asset.status = 'ready'
      and public.media_asset_has_storage_object(asset.storage_path)
      and public.is_organization_member(p_organization_id)
      and (
        (p_group_id is null and not p_ungrouped)
        or (p_group_id is not null and exists (
          select 1 from public.media_group_assignments assignment
          where assignment.organization_id = p_organization_id
            and assignment.media_asset_id = asset.id
            and assignment.group_id = p_group_id
        ))
        or (p_ungrouped and not exists (
          select 1 from public.media_group_assignments assignment
          where assignment.organization_id = p_organization_id
            and assignment.media_asset_id = asset.id
        ))
      )
  )
  select state.id as media_asset_id, state.created_at
  from media_state state
  where (
    p_usage_filter = 'all'
    or (p_usage_filter = 'available' and not state.is_scheduled and not state.is_published)
    or (p_usage_filter = 'scheduled' and state.is_scheduled)
    or (p_usage_filter = 'published' and state.is_published)
  )
  and (
    p_cursor_created_at is null
    or state.created_at < p_cursor_created_at
    or (state.created_at = p_cursor_created_at and state.id < p_cursor_id)
  )
  order by state.created_at desc, state.id desc
  limit greatest(1, least(p_limit, 101));
$$;

create or replace function public.count_composer_media_ids(
  p_organization_id uuid,
  p_usage_filter text,
  p_group_id uuid default null,
  p_ungrouped boolean default false
)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  with media_state as (
    select
      asset.id,
      exists (
        select 1
        from public.publication_item_media link
        join public.publication_items item
          on item.id = link.publication_item_id
         and item.organization_id = link.organization_id
        where link.organization_id = p_organization_id
          and link.media_asset_id = asset.id
          and public.media_item_is_active_schedule(item.status, item.execute_at, item.published_at)
      ) as is_scheduled,
      (asset.first_published_at is not null) as is_published
    from public.media_assets asset
    where asset.organization_id = p_organization_id
      and asset.deleted_at is null
      and asset.deletion_requested_at is null
      and asset.status = 'ready'
      and public.media_asset_has_storage_object(asset.storage_path)
      and public.is_organization_member(p_organization_id)
      and (
        (p_group_id is null and not p_ungrouped)
        or (p_group_id is not null and exists (
          select 1 from public.media_group_assignments assignment
          where assignment.organization_id = p_organization_id
            and assignment.media_asset_id = asset.id
            and assignment.group_id = p_group_id
        ))
        or (p_ungrouped and not exists (
          select 1 from public.media_group_assignments assignment
          where assignment.organization_id = p_organization_id
            and assignment.media_asset_id = asset.id
        ))
      )
  )
  select count(*)::integer
  from media_state state
  where (
    p_usage_filter = 'all'
    or (p_usage_filter = 'available' and not state.is_scheduled and not state.is_published)
    or (p_usage_filter = 'scheduled' and state.is_scheduled)
    or (p_usage_filter = 'published' and state.is_published)
  );
$$;

-- Reaplica listagens para esconder mídias já pedidas para exclusão.
create or replace function public.list_gallery_media_ids(
  p_organization_id uuid,
  p_situation_filter text default 'all',
  p_type_filter text default 'all',
  p_group_id uuid default null,
  p_ungrouped boolean default false,
  p_search text default '',
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null,
  p_limit integer default 31
)
returns table (media_asset_id uuid, created_at timestamptz)
language sql stable security definer set search_path = public
as $$
  with media_state as (
    select asset.id, asset.created_at, asset.status, (asset.first_published_at is not null) as is_published,
      exists (
        select 1 from public.publication_item_media link
        join public.publication_items item on item.id = link.publication_item_id and item.organization_id = link.organization_id
        where link.organization_id = p_organization_id and link.media_asset_id = asset.id
          and public.media_item_is_active_schedule(item.status, item.execute_at, item.published_at)
      ) as is_scheduled
    from public.media_assets asset
    where asset.organization_id = p_organization_id
      and asset.deleted_at is null
      and asset.deletion_requested_at is null
      and public.media_asset_has_storage_object(asset.storage_path)
      and public.is_organization_member(p_organization_id)
      and (p_type_filter = 'all' or asset.kind::text = p_type_filter)
      and (coalesce(nullif(trim(p_search), ''), '') = '' or asset.original_name ilike ('%' || replace(replace(replace(trim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%') escape '\')
      and ((p_group_id is null and not p_ungrouped) or (p_group_id is not null and exists (select 1 from public.media_group_assignments assignment where assignment.organization_id = p_organization_id and assignment.media_asset_id = asset.id and assignment.group_id = p_group_id)) or (p_ungrouped and not exists (select 1 from public.media_group_assignments assignment where assignment.organization_id = p_organization_id and assignment.media_asset_id = asset.id)))
  )
  select state.id, state.created_at
  from media_state state
  where (p_situation_filter = 'all'
    or (p_situation_filter = 'schedulable' and state.status = 'ready' and not state.is_published and not state.is_scheduled)
    or (p_situation_filter = 'unposted' and not state.is_published and not state.is_scheduled)
    or (p_situation_filter = 'scheduled' and state.is_scheduled)
    or (p_situation_filter = 'posted' and state.is_published)
    or (p_situation_filter = 'posted_scheduled' and state.is_published and state.is_scheduled)
    or (p_situation_filter in ('uploaded', 'processing', 'ready', 'failed') and state.status::text = p_situation_filter))
    and (p_cursor_created_at is null or state.created_at < p_cursor_created_at or (state.created_at = p_cursor_created_at and state.id < p_cursor_id))
  order by state.created_at desc, state.id desc
  limit greatest(1, least(p_limit, 101));
$$;

create or replace function public.count_gallery_media_ids(
  p_organization_id uuid,
  p_situation_filter text default 'all',
  p_type_filter text default 'all',
  p_group_id uuid default null,
  p_ungrouped boolean default false,
  p_search text default ''
)
returns integer
language sql stable security definer set search_path = public
as $$
  with media_state as (
    select asset.id, asset.status, (asset.first_published_at is not null) as is_published,
      exists (
        select 1 from public.publication_item_media link
        join public.publication_items item on item.id = link.publication_item_id and item.organization_id = link.organization_id
        where link.organization_id = p_organization_id and link.media_asset_id = asset.id
          and public.media_item_is_active_schedule(item.status, item.execute_at, item.published_at)
      ) as is_scheduled
    from public.media_assets asset
    where asset.organization_id = p_organization_id
      and asset.deleted_at is null
      and asset.deletion_requested_at is null
      and public.media_asset_has_storage_object(asset.storage_path)
      and public.is_organization_member(p_organization_id)
      and (p_type_filter = 'all' or asset.kind::text = p_type_filter)
      and (coalesce(nullif(trim(p_search), ''), '') = '' or asset.original_name ilike ('%' || replace(replace(replace(trim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%') escape '\')
      and ((p_group_id is null and not p_ungrouped) or (p_group_id is not null and exists (select 1 from public.media_group_assignments assignment where assignment.organization_id = p_organization_id and assignment.media_asset_id = asset.id and assignment.group_id = p_group_id)) or (p_ungrouped and not exists (select 1 from public.media_group_assignments assignment where assignment.organization_id = p_organization_id and assignment.media_asset_id = asset.id)))
  )
  select count(*)::integer
  from media_state state
  where (p_situation_filter = 'all'
    or (p_situation_filter = 'schedulable' and state.status = 'ready' and not state.is_published and not state.is_scheduled)
    or (p_situation_filter = 'unposted' and not state.is_published and not state.is_scheduled)
    or (p_situation_filter = 'scheduled' and state.is_scheduled)
    or (p_situation_filter = 'posted' and state.is_published)
    or (p_situation_filter = 'posted_scheduled' and state.is_published and state.is_scheduled)
    or (p_situation_filter in ('uploaded', 'processing', 'ready', 'failed') and state.status::text = p_situation_filter));
$$;

create or replace function public.list_gallery_media_ids_for_deletion(
  p_organization_id uuid,
  p_situation_filter text default 'all',
  p_type_filter text default 'all',
  p_group_id uuid default null,
  p_ungrouped boolean default false,
  p_search text default '',
  p_limit integer default 50000
)
returns table (media_asset_id uuid)
language sql stable security definer set search_path = public
as $$
  with media_state as (
    select asset.id, asset.status, (asset.first_published_at is not null) as is_published,
      exists (
        select 1 from public.publication_item_media link
        join public.publication_items item on item.id = link.publication_item_id and item.organization_id = link.organization_id
        where link.organization_id = p_organization_id and link.media_asset_id = asset.id
          and public.media_item_is_active_schedule(item.status, item.execute_at, item.published_at)
      ) as is_scheduled
    from public.media_assets asset
    where asset.organization_id = p_organization_id
      and asset.deleted_at is null
      and asset.deletion_requested_at is null
      and public.media_asset_has_storage_object(asset.storage_path)
      and public.is_organization_member(p_organization_id)
      and (p_type_filter = 'all' or asset.kind::text = p_type_filter)
      and (coalesce(nullif(trim(p_search), ''), '') = '' or asset.original_name ilike ('%' || replace(replace(replace(trim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%') escape '\')
      and ((p_group_id is null and not p_ungrouped) or (p_group_id is not null and exists (select 1 from public.media_group_assignments assignment where assignment.organization_id = p_organization_id and assignment.media_asset_id = asset.id and assignment.group_id = p_group_id)) or (p_ungrouped and not exists (select 1 from public.media_group_assignments assignment where assignment.organization_id = p_organization_id and assignment.media_asset_id = asset.id)))
  )
  select state.id
  from media_state state
  where (p_situation_filter = 'all'
    or (p_situation_filter = 'schedulable' and state.status = 'ready' and not state.is_published and not state.is_scheduled)
    or (p_situation_filter = 'unposted' and not state.is_published and not state.is_scheduled)
    or (p_situation_filter = 'scheduled' and state.is_scheduled)
    or (p_situation_filter = 'posted' and state.is_published)
    or (p_situation_filter = 'posted_scheduled' and state.is_published and state.is_scheduled)
    or (p_situation_filter in ('uploaded', 'processing', 'ready', 'failed') and state.status::text = p_situation_filter))
  order by state.id
  limit least(greatest(p_limit, 1), 50000);
$$;

grant execute on function public.delete_media_assets_and_remove_publication_items(uuid, uuid[]) to authenticated, service_role;
grant execute on function public.list_composer_media_ids(uuid, text, uuid, boolean, timestamptz, uuid, integer) to authenticated, service_role;
grant execute on function public.count_composer_media_ids(uuid, text, uuid, boolean) to authenticated, service_role;
grant execute on function public.list_gallery_media_ids(uuid, text, text, uuid, boolean, text, timestamptz, uuid, integer) to authenticated, service_role;
grant execute on function public.count_gallery_media_ids(uuid, text, text, uuid, boolean, text) to authenticated, service_role;
grant execute on function public.list_gallery_media_ids_for_deletion(uuid, text, text, uuid, boolean, text, integer) to authenticated, service_role;
