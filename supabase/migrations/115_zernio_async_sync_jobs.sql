-- Sincronia mestre durável: a requisição web apenas enfileira. A VPS reivindica
-- poucas chaves por ciclo e o progresso fica persistido para polling da UI.

create type public.zernio_sync_item_status as enum ('queued', 'processing', 'completed', 'failed');

create table public.zernio_sync_batch_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.zernio_sync_batches(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  zernio_connection_id uuid not null references public.zernio_connections(id) on delete restrict,
  status public.zernio_sync_item_status not null default 'queued',
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default timezone('utc', now()),
  claimed_by text,
  lease_until timestamptz,
  synced_count integer not null default 0 check (synced_count >= 0),
  conflict_count integer not null default 0 check (conflict_count >= 0),
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (batch_id, zernio_connection_id)
);

create index zernio_sync_batch_items_claim_idx
  on public.zernio_sync_batch_items (status, next_attempt_at, lease_until, created_at)
  where status in ('queued', 'processing');
create index zernio_sync_batch_items_batch_idx
  on public.zernio_sync_batch_items (batch_id, status, created_at);

create trigger zernio_sync_batch_items_set_updated_at
before update on public.zernio_sync_batch_items
for each row execute function public.set_updated_at();

create or replace function public.enqueue_zernio_organization_sync_batch(
  p_organization_id uuid,
  p_requested_by uuid,
  p_lock_holder uuid
)
returns table (batch_id uuid, total_connections integer, reused boolean)
language plpgsql security definer set search_path = public as $$
declare
  active_batch_id uuid;
  created_batch_id uuid;
  connection_count integer;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':zernio-sync-enqueue', 0));
  select id into active_batch_id from public.zernio_sync_batches
  where organization_id = p_organization_id and status = 'processing'
  order by created_at desc limit 1 for update;
  if active_batch_id is not null then
    select count(*)::integer into connection_count
    from public.zernio_sync_batch_items where batch_id = active_batch_id;
    batch_id := active_batch_id;
    total_connections := connection_count;
    reused := true;
    return next;
    return;
  end if;

  insert into public.zernio_sync_batches (organization_id, requested_by, lock_holder, status)
  values (p_organization_id, p_requested_by, p_lock_holder, 'processing')
  returning id into created_batch_id;

  insert into public.zernio_sync_batch_items (batch_id, organization_id, zernio_connection_id)
  select created_batch_id, p_organization_id, connection.id
  from public.zernio_connections connection
  where connection.organization_id = p_organization_id and connection.deleted_at is null
  order by connection.created_at, connection.id;
  get diagnostics connection_count = row_count;

  update public.zernio_sync_batches
  set total_connections = connection_count,
      status = case when connection_count = 0 then 'completed' else 'processing' end,
      completed_at = case when connection_count = 0 then timezone('utc', now()) else null end
  where id = created_batch_id;

  batch_id := created_batch_id;
  total_connections := connection_count;
  reused := false;
  return next;
end;
$$;

create or replace function public.claim_zernio_sync_batch_items(
  p_worker_id text,
  p_limit integer default 3,
  p_lease_seconds integer default 180
)
returns table (item_id uuid, batch_id uuid, organization_id uuid, requested_by uuid, zernio_connection_id uuid, attempt_count integer)
language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao worker.';
  end if;
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120
    or p_limit not between 1 and 20 or p_lease_seconds not between 30 and 900 then
    raise exception using errcode = '22023', message = 'Parâmetros de claim inválidos.';
  end if;
  return query with candidates as (
    select item.id
    from public.zernio_sync_batch_items item
    join public.zernio_sync_batches batch on batch.id = item.batch_id
    where batch.status = 'processing'
      and item.status in ('queued', 'processing')
      and item.next_attempt_at <= timezone('utc', now())
      and (item.lease_until is null or item.lease_until <= timezone('utc', now()))
    order by item.next_attempt_at, item.created_at, item.id
    for update skip locked limit p_limit
  ), claimed as (
    update public.zernio_sync_batch_items item
    set status = 'processing', claimed_by = trim(p_worker_id),
        lease_until = timezone('utc', now()) + make_interval(secs => p_lease_seconds),
        attempt_count = item.attempt_count + 1, started_at = coalesce(item.started_at, timezone('utc', now()))
    from candidates where item.id = candidates.id
    returning item.id, item.batch_id, item.organization_id, item.zernio_connection_id, item.attempt_count
  )
  select claimed.id, claimed.batch_id, claimed.organization_id, batch.requested_by, claimed.zernio_connection_id, claimed.attempt_count
  from claimed join public.zernio_sync_batches batch on batch.id = claimed.batch_id;
end;
$$;

create or replace function public.complete_zernio_sync_batch_item(
  p_item_id uuid,
  p_worker_id text,
  p_synced_count integer default 0,
  p_conflict_count integer default 0,
  p_error_message text default null
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  item_row public.zernio_sync_batch_items%rowtype;
  retry_seconds integer;
  remaining_count integer;
  failed_count integer;
  synced_total integer;
  conflict_total integer;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao worker.';
  end if;
  select * into item_row from public.zernio_sync_batch_items
  where id = p_item_id and claimed_by = trim(p_worker_id) and lease_until > timezone('utc', now()) and status = 'processing'
  for update;
  if not found then raise exception using errcode = 'P0002', message = 'Item não está sob lease deste worker.'; end if;

  if nullif(trim(coalesce(p_error_message, '')), '') is not null and item_row.attempt_count < 3 then
    retry_seconds := least(900, 30 * power(2, item_row.attempt_count - 1)::integer);
    update public.zernio_sync_batch_items
    set status = 'queued', claimed_by = null, lease_until = null,
        next_attempt_at = timezone('utc', now()) + make_interval(secs => retry_seconds),
        error_message = left(trim(p_error_message), 1200)
    where id = item_row.id;
    return jsonb_build_object('completed', false, 'retryAtSeconds', retry_seconds);
  end if;

  update public.zernio_sync_batch_items
  set status = case when nullif(trim(coalesce(p_error_message, '')), '') is null then 'completed' else 'failed' end,
      claimed_by = null, lease_until = null, synced_count = greatest(0, p_synced_count),
      conflict_count = greatest(0, p_conflict_count), error_message = left(nullif(trim(p_error_message), ''), 1200),
      completed_at = timezone('utc', now())
  where id = item_row.id;

  select count(*) filter (where status in ('queued', 'processing'))::integer,
         count(*) filter (where status = 'failed')::integer,
         coalesce(sum(synced_count), 0)::integer,
         coalesce(sum(conflict_count), 0)::integer
  into remaining_count, failed_count, synced_total, conflict_total
  from public.zernio_sync_batch_items where batch_id = item_row.batch_id;
  if remaining_count = 0 then
    update public.zernio_sync_batches
    set status = case when failed_count > 0 or conflict_total > 0 then 'completed_with_errors' else 'completed' end,
        synced_count = synced_total, conflict_count = conflict_total, failure_count = failed_count,
        completed_at = timezone('utc', now())
    where id = item_row.batch_id;
  end if;
  return jsonb_build_object('completed', true, 'batchId', item_row.batch_id, 'remaining', remaining_count);
end;
$$;

alter table public.zernio_sync_batch_items enable row level security;
create policy zernio_sync_batch_items_select_member on public.zernio_sync_batch_items
  for select to authenticated using (public.is_organization_member(organization_id));
revoke all on public.zernio_sync_batch_items from public, anon, authenticated;
grant select on public.zernio_sync_batch_items to authenticated;
grant all on public.zernio_sync_batch_items to service_role;
revoke all on function public.enqueue_zernio_organization_sync_batch(uuid, uuid, uuid), public.claim_zernio_sync_batch_items(text, integer, integer), public.complete_zernio_sync_batch_item(uuid, text, integer, integer, text) from public, anon, authenticated;
grant execute on function public.enqueue_zernio_organization_sync_batch(uuid, uuid, uuid), public.claim_zernio_sync_batch_items(text, integer, integer), public.complete_zernio_sync_batch_item(uuid, text, integer, integer, text) to service_role;
