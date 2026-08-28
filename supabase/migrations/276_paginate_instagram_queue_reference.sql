-- Mantem o custo de transferencia da /queue constante: totais globais e uma
-- unica pagina de agregados por chamada. Detalhes de itens nao fazem parte
-- desta projecao.

create index if not exists publication_items_queue_profile_page_idx
  on public.publication_items (organization_id, profile_id, status, execute_at)
  where archived_at is null;

create index if not exists publication_items_queue_batch_page_idx
  on public.publication_items (organization_id, batch_id, status, execute_at)
  where archived_at is null;

create or replace function public.get_publication_queue_reference_page(
  p_organization_id uuid,
  p_scope text default 'account',
  p_limit integer default 25,
  p_offset integer default 0
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with authorized as (
    select p_organization_id as organization_id
    where auth.role() = 'service_role'
      or public.is_organization_member(p_organization_id)
  ), operational_items as materialized (
    select
      item.*,
      acknowledgement.publication_item_id is not null as failure_acknowledged
    from public.publication_items item
    join authorized auth_org on auth_org.organization_id = item.organization_id
    left join public.publication_failure_acknowledgements acknowledgement
      on acknowledgement.publication_item_id = item.id
    where item.archived_at is null
  ), totals as (
    select
      count(*) filter (where status not in ('cancelled', 'removed', 'ignored'))::integer as total,
      count(*)::integer as historical_total,
      count(*) filter (where status = 'published')::integer as ok,
      count(*) filter (where status in ('waiting', 'ready'))::integer as pending,
      count(*) filter (where status in ('preparing', 'publishing'))::integer as processing,
      count(*) filter (where status = 'failed' and not failure_acknowledged)::integer as errors,
      count(*) filter (where status = 'failed' and failure_acknowledged)::integer as acknowledged_errors,
      count(*) filter (where status = 'suspended')::integer as suspended,
      count(*) filter (where status in ('waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended'))::integer as active,
      count(*) filter (where status in ('cancelled', 'removed', 'ignored'))::integer as closed,
      count(*) filter (
        where status in ('preparing', 'publishing')
          and lease_until is not null
          and lease_until <= timezone('utc', now())
      )::integer as expired_leases,
      count(distinct profile_id) filter (
        where status in ('waiting', 'ready', 'preparing', 'publishing', 'failed')
      )::integer as active_accounts,
      count(distinct profile_id) filter (where status = 'suspended')::integer as suspended_accounts,
      count(distinct profile_id) filter (where status not in ('cancelled', 'removed', 'ignored'))::integer as total_accounts
    from operational_items
  ), profile_membership as materialized (
    select member.profile_id, member.group_id
    from public.profile_group_members member
    join authorized auth_org on auth_org.organization_id = member.organization_id
  ), rows as (
    select
      item.profile_id::text as id,
      null::text as title,
      profile.username::text as username,
      profile.display_name::text as display_name,
      profile.profile_picture_url::text as profile_picture_url,
      null::integer as profile_count,
      null::timestamptz as created_at,
      count(*) filter (where item.status not in ('cancelled', 'removed', 'ignored'))::integer as total,
      count(*)::integer as historical_total,
      count(*) filter (where item.status = 'published')::integer as completed,
      count(*) filter (where item.status = 'failed' and not item.failure_acknowledged)::integer as errors,
      count(*) filter (where item.status = 'suspended')::integer as suspended,
      count(*) filter (where item.status in ('waiting', 'ready'))::integer as pending,
      count(*) filter (where item.status in ('preparing', 'publishing'))::integer as processing,
      count(*) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended'))::integer as active,
      count(*) filter (where item.status in ('cancelled', 'removed', 'ignored'))::integer as closed,
      min(item.execute_at) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing')) as next_at,
      case
        when bool_or(item.status in ('preparing', 'publishing')) then 'posting'
        when bool_or(item.status = 'failed' and not item.failure_acknowledged) then 'error'
        when bool_or(item.status in ('waiting', 'ready')) then 'idle'
        when bool_or(item.status = 'suspended') then 'suspended'
        else 'done'
      end::text as tone
    from operational_items item
    join public.instagram_profiles profile on profile.id = item.profile_id
    where p_scope = 'account'
    group by item.profile_id, profile.username, profile.display_name, profile.profile_picture_url

    union all

    select
      item.batch_id::text,
      coalesce(batch.name, 'Sem campanha')::text,
      null::text,
      null::text,
      null::text,
      null::integer,
      batch.created_at,
      count(*) filter (where item.status not in ('cancelled', 'removed', 'ignored'))::integer,
      count(*)::integer,
      count(*) filter (where item.status = 'published')::integer,
      count(*) filter (where item.status = 'failed' and not item.failure_acknowledged)::integer,
      count(*) filter (where item.status = 'suspended')::integer,
      count(*) filter (where item.status in ('waiting', 'ready'))::integer,
      count(*) filter (where item.status in ('preparing', 'publishing'))::integer,
      count(*) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended'))::integer,
      count(*) filter (where item.status in ('cancelled', 'removed', 'ignored'))::integer,
      min(item.execute_at) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing')),
      case
        when bool_or(item.status in ('preparing', 'publishing')) then 'posting'
        when bool_or(item.status = 'failed' and not item.failure_acknowledged) then 'error'
        when bool_or(item.status in ('waiting', 'ready')) then 'idle'
        when bool_or(item.status = 'suspended') then 'suspended'
        else 'done'
      end::text
    from operational_items item
    join public.publication_batches batch on batch.id = item.batch_id
    where p_scope = 'batch'
    group by item.batch_id, batch.name, batch.created_at

    union all

    select
      coalesce(membership.group_id::text, 'none'),
      coalesce(profile_group.name, 'Sem grupo')::text,
      null::text,
      null::text,
      null::text,
      count(distinct item.profile_id)::integer,
      null::timestamptz,
      count(*) filter (where item.status not in ('cancelled', 'removed', 'ignored'))::integer,
      count(*)::integer,
      count(*) filter (where item.status = 'published')::integer,
      count(*) filter (where item.status = 'failed' and not item.failure_acknowledged)::integer,
      count(*) filter (where item.status = 'suspended')::integer,
      count(*) filter (where item.status in ('waiting', 'ready'))::integer,
      count(*) filter (where item.status in ('preparing', 'publishing'))::integer,
      count(*) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended'))::integer,
      count(*) filter (where item.status in ('cancelled', 'removed', 'ignored'))::integer,
      min(item.execute_at) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing')),
      case
        when bool_or(item.status in ('preparing', 'publishing')) then 'posting'
        when bool_or(item.status = 'failed' and not item.failure_acknowledged) then 'error'
        when bool_or(item.status in ('waiting', 'ready')) then 'idle'
        when bool_or(item.status = 'suspended') then 'suspended'
        else 'done'
      end::text
    from operational_items item
    left join profile_membership membership on membership.profile_id = item.profile_id
    left join public.profile_groups profile_group on profile_group.id = membership.group_id
    where p_scope = 'group'
    group by membership.group_id, profile_group.name
  ), visible_rows as (
    select * from rows where total > 0
  ), paged_rows as (
    select *
    from visible_rows
    order by
      (errors > 0) desc,
      (processing > 0) desc,
      (pending > 0) desc,
      next_at nulls last,
      coalesce(username, title, '') asc,
      id asc
    limit least(greatest(coalesce(p_limit, 25), 1), 100)
    offset least(greatest(coalesce(p_offset, 0), 0), 1000000)
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
      'historicalTotal', totals.historical_total,
      'ok', totals.ok,
      'pending', totals.pending,
      'processing', totals.processing,
      'errors', totals.errors,
      'acknowledgedErrors', totals.acknowledged_errors,
      'suspended', totals.suspended,
      'active', totals.active,
      'closed', totals.closed,
      'archived', archived.total,
      'expiredLeases', totals.expired_leases,
      'activeAccounts', totals.active_accounts,
      'suspendedAccounts', totals.suspended_accounts,
      'totalAccounts', totals.total_accounts,
      'progress', case when totals.total = 0 then 0 else round(totals.ok::numeric * 100 / totals.total)::integer end
    ),
    'rows', coalesce((select jsonb_agg(to_jsonb(paged_rows)) from paged_rows), '[]'::jsonb),
    'page', jsonb_build_object(
      'scope', p_scope,
      'offset', least(greatest(coalesce(p_offset, 0), 0), 1000000),
      'limit', least(greatest(coalesce(p_limit, 25), 1), 100),
      'totalCount', (select count(*)::integer from visible_rows),
      'hasMore', least(greatest(coalesce(p_offset, 0), 0), 1000000)
        + least(greatest(coalesce(p_limit, 25), 1), 100)
        < (select count(*) from visible_rows)
    )
  )
  from totals cross join archived
  where p_scope in ('account', 'batch', 'group');
$$;

revoke all on function public.get_publication_queue_reference_page(uuid, text, integer, integer) from public, anon;
grant execute on function public.get_publication_queue_reference_page(uuid, text, integer, integer) to authenticated, service_role;

notify pgrst, 'reload schema';
