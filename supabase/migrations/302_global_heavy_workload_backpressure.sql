-- Operações administrativas legítimas podem gerar picos simultâneos muito maiores
-- que o compute do projeto. Um lease global serializa apenas trabalho pesado;
-- publicação em horário e leituras da interface não dependem dele.

create table if not exists public.operational_heavy_workload_lease (
  slot smallint primary key check (slot = 1),
  category text,
  holder text,
  organization_id uuid references public.organizations(id) on delete set null,
  actor_user_id uuid references auth.users(id) on delete set null,
  lease_token uuid,
  acquired_at timestamptz,
  expires_at timestamptz,
  check (
    (lease_token is null and category is null and holder is null and acquired_at is null and expires_at is null)
    or
    (lease_token is not null and category is not null and holder is not null and acquired_at is not null and expires_at is not null)
  )
);

insert into public.operational_heavy_workload_lease (slot)
values (1)
on conflict (slot) do nothing;

alter table public.operational_heavy_workload_lease enable row level security;
revoke all on public.operational_heavy_workload_lease from public, anon, authenticated;
grant all on public.operational_heavy_workload_lease to service_role;

create or replace function public.acquire_operational_heavy_workload_lease(
  p_category text,
  p_holder text,
  p_organization_id uuid default null,
  p_lease_seconds integer default 120
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  requested_token uuid := gen_random_uuid();
  acquired_token uuid;
  actor_id uuid := auth.uid();
begin
  if trim(coalesce(p_category, '')) not in ('bulk_generation', 'queue_cleanup', 'zernio_sync')
    or char_length(trim(coalesce(p_holder, ''))) not between 3 and 160 then
    raise exception using errcode = '22023', message = 'Lease operacional inválido.';
  end if;

  if auth.role() <> 'service_role' and (
    actor_id is null
    or p_organization_id is null
    or not public.has_organization_role(
      p_organization_id,
      array['admin', 'operator']::public.organization_role[]
    )
  ) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  update public.operational_heavy_workload_lease
  set category = trim(p_category),
      holder = trim(p_holder),
      organization_id = p_organization_id,
      actor_user_id = actor_id,
      lease_token = requested_token,
      acquired_at = timezone('utc', now()),
      expires_at = timezone('utc', now())
        + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 15), 300))
  where slot = 1
    and (lease_token is null or expires_at <= timezone('utc', now()))
  returning lease_token into acquired_token;

  return acquired_token;
end;
$$;

create or replace function public.release_operational_heavy_workload_lease(
  p_lease_token uuid
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  released boolean := false;
begin
  if p_lease_token is null then return false; end if;

  update public.operational_heavy_workload_lease
  set category = null,
      holder = null,
      organization_id = null,
      actor_user_id = null,
      lease_token = null,
      acquired_at = null,
      expires_at = null
  where slot = 1
    and lease_token = p_lease_token
    and (auth.role() = 'service_role' or actor_user_id = auth.uid());
  released := found;
  return released;
end;
$$;

revoke all on function public.acquire_operational_heavy_workload_lease(text,text,uuid,integer)
  from public, anon;
grant execute on function public.acquire_operational_heavy_workload_lease(text,text,uuid,integer)
  to authenticated, service_role;
revoke all on function public.release_operational_heavy_workload_lease(uuid)
  from public, anon;
grant execute on function public.release_operational_heavy_workload_lease(uuid)
  to authenticated, service_role;

create index if not exists publication_items_finished_cleanup_idx
  on public.publication_items (organization_id, status, created_at, id)
  where archived_at is null
    and status in ('published', 'cancelled', 'removed', 'ignored', 'failed');

create or replace function public.clean_publication_queue_finished(
  p_organization_id uuid,
  p_limit integer default 250
)
returns table (
  archived_completed_count integer,
  archived_failure_count integer,
  remaining_finished_count bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  resolved_limit integer := least(greatest(coalesce(p_limit, 250), 1), 250);
  completed_count integer := 0;
  failure_count integer := 0;
  remaining_count bigint := 0;
begin
  if auth.role() <> 'service_role' and (
    actor_id is null or not public.has_organization_role(
      p_organization_id,
      array['admin', 'operator']::public.organization_role[]
    )
  ) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  with candidates as (
    select item.id
    from public.publication_items item
    where item.organization_id = p_organization_id
      and item.archived_at is null
      and item.status in ('published', 'cancelled', 'removed', 'ignored')
    order by item.created_at, item.id
    limit resolved_limit
    for update skip locked
  ), archived as (
    update public.publication_items item
    set archived_at = timezone('utc', now()), archived_by = actor_id
    from candidates
    where item.id = candidates.id
    returning item.id
  )
  select count(*)::integer into completed_count from archived;

  with candidates as (
    select item.id
    from public.publication_items item
    where item.organization_id = p_organization_id
      and item.archived_at is null
      and item.status = 'failed'
    order by item.created_at, item.id
    limit greatest(resolved_limit - completed_count, 0)
    for update skip locked
  ), archived as (
    update public.publication_items item
    set archived_at = timezone('utc', now()), archived_by = actor_id
    from candidates
    where item.id = candidates.id
    returning item.id
  ), acknowledged as (
    insert into public.publication_failure_acknowledgements (
      publication_item_id, organization_id, acknowledged_by, scope
    )
    select id, p_organization_id, actor_id, 'visible_items'
    from archived
    on conflict (publication_item_id) do nothing
  )
  select count(*)::integer into failure_count from archived;

  insert into public.publication_queue_action_audits (
    organization_id, actor_user_id, action, affected_count, item_ids, metadata
  ) values
    (p_organization_id, actor_id, 'archive_completed', completed_count, '{}'::uuid[],
      jsonb_build_object('scope', 'queue_cleanup', 'bulk', true, 'throttled', true)),
    (p_organization_id, actor_id, 'acknowledge_failures', failure_count, '{}'::uuid[],
      jsonb_build_object('scope', 'queue_cleanup', 'archived', true, 'bulk', true, 'throttled', true));

  select count(*) into remaining_count
  from public.publication_items item
  where item.organization_id = p_organization_id
    and item.archived_at is null
    and item.status in ('published', 'cancelled', 'removed', 'ignored', 'failed');

  return query select completed_count, failure_count, remaining_count;
end;
$$;

revoke all on function public.clean_publication_queue_finished(uuid, integer) from public, anon;
grant execute on function public.clean_publication_queue_finished(uuid, integer) to authenticated, service_role;

notify pgrst, 'reload schema';
