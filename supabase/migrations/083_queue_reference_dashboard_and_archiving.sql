-- Fila operacional de referência: arquivamento persistente, auditoria e resumo agregado global.

alter table public.publication_items
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid references auth.users (id) on delete set null;

create index if not exists publication_items_operational_org_status_idx
  on public.publication_items (organization_id, status, execute_at, created_at desc)
  where archived_at is null;

create index if not exists publication_items_archived_org_idx
  on public.publication_items (organization_id, archived_at desc)
  where archived_at is not null;

create table if not exists public.publication_queue_action_audits (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  actor_user_id uuid references auth.users (id) on delete set null,
  action text not null check (action in ('archive_completed', 'release_stuck')),
  affected_count integer not null default 0 check (affected_count >= 0),
  item_ids uuid[] not null default '{}'::uuid[],
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists publication_queue_action_audits_org_created_idx
  on public.publication_queue_action_audits (organization_id, created_at desc);

alter table public.publication_queue_action_audits enable row level security;

drop policy if exists publication_queue_action_audits_select_member on public.publication_queue_action_audits;
create policy publication_queue_action_audits_select_member
on public.publication_queue_action_audits for select to authenticated
using (public.is_organization_member(organization_id));

revoke all on table public.publication_queue_action_audits from public, anon, authenticated;
grant select on table public.publication_queue_action_audits to authenticated;

create or replace function public.archive_completed_publication_items(
  p_organization_id uuid
)
returns table (archived_count integer, archived_item_ids uuid[])
language plpgsql
security definer
set search_path = public
as $$
declare
  resolved_user_id uuid := auth.uid();
  resolved_ids uuid[] := '{}'::uuid[];
begin
  if auth.role() <> 'service_role' and not public.has_organization_role(
    p_organization_id,
    array['admin', 'operator']::public.organization_role[]
  ) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  with archived as (
    update public.publication_items item
    set archived_at = timezone('utc', now()),
        archived_by = resolved_user_id
    where item.organization_id = p_organization_id
      and item.archived_at is null
      and item.status in ('published', 'cancelled', 'removed', 'ignored')
    returning item.id
  )
  select coalesce(array_agg(id), '{}'::uuid[]) into resolved_ids from archived;

  insert into public.publication_queue_action_audits (
    organization_id, actor_user_id, action, affected_count, item_ids
  ) values (
    p_organization_id, resolved_user_id, 'archive_completed', cardinality(resolved_ids), resolved_ids
  );

  return query select cardinality(resolved_ids), resolved_ids;
end;
$$;

create or replace function public.release_expired_publication_leases(
  p_organization_id uuid
)
returns table (released_count integer, released_item_ids uuid[])
language plpgsql
security definer
set search_path = public
as $$
declare
  resolved_user_id uuid := auth.uid();
  resolved_ids uuid[] := '{}'::uuid[];
begin
  if auth.role() <> 'service_role' and not public.has_organization_role(
    p_organization_id,
    array['admin', 'operator']::public.organization_role[]
  ) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  with released as (
    update public.publication_items item
    set claimed_by = null,
        lease_until = null
    where item.organization_id = p_organization_id
      and item.archived_at is null
      and item.status in ('preparing', 'publishing')
      and item.lease_until is not null
      and item.lease_until <= timezone('utc', now())
    returning item.id
  )
  select coalesce(array_agg(id), '{}'::uuid[]) into resolved_ids from released;

  insert into public.publication_queue_action_audits (
    organization_id, actor_user_id, action, affected_count, item_ids
  ) values (
    p_organization_id, resolved_user_id, 'release_stuck', cardinality(resolved_ids), resolved_ids
  );

  return query select cardinality(resolved_ids), resolved_ids;
end;
$$;

create or replace function public.get_publication_queue_reference_summary(
  p_organization_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with authorized as (
    select p_organization_id as organization_id
    where auth.role() = 'service_role' or public.is_organization_member(p_organization_id)
  ), operational_items as (
    select item.*
    from public.publication_items item
    join authorized auth_org on auth_org.organization_id = item.organization_id
    where item.archived_at is null
  ), totals as (
    select
      count(*)::integer as total,
      count(*) filter (where status = 'published')::integer as ok,
      count(*) filter (where status in ('waiting', 'ready'))::integer as pending,
      count(*) filter (where status in ('preparing', 'publishing'))::integer as processing,
      count(*) filter (where status = 'failed')::integer as errors,
      count(*) filter (where status in ('cancelled', 'removed', 'ignored'))::integer as closed,
      count(*) filter (
        where status in ('preparing', 'publishing')
          and lease_until is not null
          and lease_until <= timezone('utc', now())
      )::integer as expired_leases,
      count(distinct profile_id) filter (
        where status in ('waiting', 'ready', 'preparing', 'publishing', 'failed')
      )::integer as active_accounts,
      count(distinct profile_id)::integer as total_accounts
    from operational_items
  ), account_rows as (
    select
      item.profile_id as id,
      profile.username,
      profile.display_name,
      profile.profile_picture_url,
      count(*)::integer as total,
      count(*) filter (where item.status = 'published')::integer as completed,
      count(*) filter (where item.status = 'failed')::integer as errors,
      count(*) filter (where item.status in ('waiting', 'ready'))::integer as pending,
      count(*) filter (where item.status in ('preparing', 'publishing'))::integer as processing,
      min(item.execute_at) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing')) as next_at,
      case
        when bool_or(item.status in ('preparing', 'publishing')) then 'posting'
        when bool_or(item.status = 'failed') then 'error'
        when bool_or(item.status in ('waiting', 'ready')) then 'idle'
        else 'done'
      end as tone
    from operational_items item
    join public.instagram_profiles profile on profile.id = item.profile_id
    group by item.profile_id, profile.username, profile.display_name, profile.profile_picture_url
  ), batch_rows as (
    select
      item.batch_id as id,
      coalesce(batch.name, 'Sem campanha') as title,
      batch.created_at,
      count(*)::integer as total,
      count(*) filter (where item.status = 'published')::integer as completed,
      count(*) filter (where item.status = 'failed')::integer as errors,
      count(*) filter (where item.status in ('waiting', 'ready'))::integer as pending,
      count(*) filter (where item.status in ('preparing', 'publishing'))::integer as processing,
      min(item.execute_at) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing')) as next_at,
      case
        when bool_or(item.status in ('preparing', 'publishing')) then 'posting'
        when bool_or(item.status = 'failed') then 'error'
        when bool_or(item.status in ('waiting', 'ready')) then 'idle'
        else 'done'
      end as tone
    from operational_items item
    join public.publication_batches batch on batch.id = item.batch_id
    group by item.batch_id, batch.name, batch.created_at
  ), profile_membership as (
    select member.profile_id, member.group_id
    from public.profile_group_members member
    join authorized auth_org on auth_org.organization_id = member.organization_id
  ), group_rows as (
    select
      coalesce(membership.group_id::text, 'none') as id,
      coalesce(profile_group.name, 'Sem grupo') as title,
      count(*)::integer as total,
      count(*) filter (where item.status = 'published')::integer as completed,
      count(*) filter (where item.status = 'failed')::integer as errors,
      count(*) filter (where item.status in ('waiting', 'ready'))::integer as pending,
      count(*) filter (where item.status in ('preparing', 'publishing'))::integer as processing,
      min(item.execute_at) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing')) as next_at,
      count(distinct item.profile_id)::integer as profile_count,
      case
        when bool_or(item.status in ('preparing', 'publishing')) then 'posting'
        when bool_or(item.status = 'failed') then 'error'
        when bool_or(item.status in ('waiting', 'ready')) then 'idle'
        else 'done'
      end as tone
    from operational_items item
    left join profile_membership membership on membership.profile_id = item.profile_id
    left join public.profile_groups profile_group on profile_group.id = membership.group_id
    group by membership.group_id, profile_group.name
  ), archived as (
    select count(*)::integer as total
    from public.publication_items item
    join authorized auth_org on auth_org.organization_id = item.organization_id
    where item.archived_at is not null
  )
  select jsonb_build_object(
    'snapshotAt', timezone('utc', now()),
    'totals', jsonb_build_object(
      'total', totals.total,
      'ok', totals.ok,
      'pending', totals.pending,
      'processing', totals.processing,
      'errors', totals.errors,
      'closed', totals.closed,
      'archived', archived.total,
      'expiredLeases', totals.expired_leases,
      'activeAccounts', totals.active_accounts,
      'totalAccounts', totals.total_accounts,
      'progress', case when totals.total = 0 then 0 else round((totals.ok::numeric / totals.total::numeric) * 100)::integer end
    ),
    'accounts', coalesce((select jsonb_agg(to_jsonb(account_rows) order by processing desc, errors desc, next_at nulls last, username) from account_rows), '[]'::jsonb),
    'batches', coalesce((select jsonb_agg(to_jsonb(batch_rows) order by processing desc, errors desc, created_at desc) from batch_rows), '[]'::jsonb),
    'groups', coalesce((select jsonb_agg(to_jsonb(group_rows) order by processing desc, errors desc, title) from group_rows), '[]'::jsonb)
  )
  from totals cross join archived;
$$;

create or replace function public.get_publication_queue_operational_summary(
  p_organization_id uuid default null
)
returns table (
  organization_id uuid,
  status public.publication_item_status,
  total integer,
  expired_leases integer,
  due_retries integer,
  overdue integer,
  oldest_execute_at timestamptz,
  max_lag_seconds integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    item.organization_id,
    item.status,
    count(*)::integer,
    count(*) filter (where item.lease_until is not null and item.lease_until <= timezone('utc', now()))::integer,
    count(*) filter (where item.status = 'failed' and item.next_attempt_at is not null and item.next_attempt_at <= timezone('utc', now()))::integer,
    count(*) filter (where item.status in ('waiting', 'ready') and item.execute_at is not null and item.execute_at < timezone('utc', now()) - interval '120 seconds')::integer,
    min(item.execute_at) filter (where item.execute_at is not null),
    coalesce(max(greatest(0, extract(epoch from (timezone('utc', now()) - item.execute_at))::integer)) filter (
      where item.execute_at is not null
        and item.execute_at < timezone('utc', now())
        and item.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed')
    ), 0)::integer
  from public.publication_items item
  where item.archived_at is null
    and item.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed')
    and (p_organization_id is null or item.organization_id = p_organization_id)
    and (auth.role() = 'service_role' or public.is_organization_member(item.organization_id))
  group by item.organization_id, item.status
  order by item.organization_id, item.status;
$$;

revoke all on function public.archive_completed_publication_items(uuid) from public, anon;
revoke all on function public.release_expired_publication_leases(uuid) from public, anon;
revoke all on function public.get_publication_queue_reference_summary(uuid) from public, anon;
grant execute on function public.archive_completed_publication_items(uuid) to authenticated, service_role;
grant execute on function public.release_expired_publication_leases(uuid) to authenticated, service_role;
grant execute on function public.get_publication_queue_reference_summary(uuid) to authenticated, service_role;
