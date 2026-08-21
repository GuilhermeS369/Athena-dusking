-- O resumo da fila é operacional: cancelamentos e remoções permanecem
-- auditáveis em `closed`, mas não podem inflar a capacidade que ainda existe.
create or replace function public.get_publication_queue_reference_summary(
  p_organization_id uuid
)
returns jsonb
language sql stable security definer set search_path = public as $$
  with authorized as (
    select p_organization_id as organization_id
    where auth.role() = 'service_role' or public.is_organization_member(p_organization_id)
  ), operational_items as (
    select item.*, acknowledgement.publication_item_id is not null as failure_acknowledged
    from public.publication_items item
    join authorized auth_org on auth_org.organization_id = item.organization_id
    left join public.publication_failure_acknowledgements acknowledgement on acknowledgement.publication_item_id = item.id
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
      count(*) filter (where status in ('preparing', 'publishing') and lease_until is not null and lease_until <= timezone('utc', now()))::integer as expired_leases,
      count(distinct profile_id) filter (where status in ('waiting', 'ready', 'preparing', 'publishing', 'failed'))::integer as active_accounts,
      count(distinct profile_id) filter (where status = 'suspended')::integer as suspended_accounts,
      count(distinct profile_id) filter (where status not in ('cancelled', 'removed', 'ignored'))::integer as total_accounts
    from operational_items
  ), account_rows as (
    select item.profile_id as id, profile.username, profile.display_name, profile.profile_picture_url,
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
      case when bool_or(item.status in ('preparing', 'publishing')) then 'posting' when bool_or(item.status = 'failed' and not item.failure_acknowledged) then 'error' when bool_or(item.status in ('waiting', 'ready')) then 'idle' when bool_or(item.status = 'suspended') then 'suspended' else 'done' end as tone
    from operational_items item join public.instagram_profiles profile on profile.id = item.profile_id
    group by item.profile_id, profile.username, profile.display_name, profile.profile_picture_url
  ), batch_rows as (
    select item.batch_id as id, coalesce(batch.name, 'Sem campanha') as title, batch.created_at,
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
      case when bool_or(item.status in ('preparing', 'publishing')) then 'posting' when bool_or(item.status = 'failed' and not item.failure_acknowledged) then 'error' when bool_or(item.status in ('waiting', 'ready')) then 'idle' when bool_or(item.status = 'suspended') then 'suspended' else 'done' end as tone
    from operational_items item join public.publication_batches batch on batch.id = item.batch_id
    group by item.batch_id, batch.name, batch.created_at
  ), profile_membership as (
    select member.profile_id, member.group_id from public.profile_group_members member join authorized auth_org on auth_org.organization_id = member.organization_id
  ), group_rows as (
    select coalesce(membership.group_id::text, 'none') as id, coalesce(profile_group.name, 'Sem grupo') as title,
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
      count(distinct item.profile_id)::integer as profile_count,
      case when bool_or(item.status in ('preparing', 'publishing')) then 'posting' when bool_or(item.status = 'failed' and not item.failure_acknowledged) then 'error' when bool_or(item.status in ('waiting', 'ready')) then 'idle' when bool_or(item.status = 'suspended') then 'suspended' else 'done' end as tone
    from operational_items item left join profile_membership membership on membership.profile_id = item.profile_id left join public.profile_groups profile_group on profile_group.id = membership.group_id
    group by membership.group_id, profile_group.name
  ), archived as (
    select count(*)::integer as total from public.publication_items item join authorized auth_org on auth_org.organization_id = item.organization_id where item.archived_at is not null
  ) select jsonb_build_object(
    'snapshotAt', timezone('utc', now()),
    'totals', jsonb_build_object('total', totals.total, 'historicalTotal', totals.historical_total, 'ok', totals.ok, 'pending', totals.pending, 'processing', totals.processing, 'errors', totals.errors, 'acknowledgedErrors', totals.acknowledged_errors, 'suspended', totals.suspended, 'active', totals.active, 'closed', totals.closed, 'archived', archived.total, 'expiredLeases', totals.expired_leases, 'activeAccounts', totals.active_accounts, 'suspendedAccounts', totals.suspended_accounts, 'totalAccounts', totals.total_accounts, 'progress', case when totals.total = 0 then 0 else round(totals.ok::numeric * 100 / totals.total)::integer end),
    'accounts', coalesce((select jsonb_agg(to_jsonb(account_rows) order by account_rows.errors desc, account_rows.processing desc, account_rows.pending desc, account_rows.username) from account_rows where account_rows.total > 0), '[]'::jsonb),
    'batches', coalesce((select jsonb_agg(to_jsonb(batch_rows) order by batch_rows.errors desc, batch_rows.processing desc, batch_rows.pending desc, batch_rows.created_at desc) from batch_rows where batch_rows.total > 0), '[]'::jsonb),
    'groups', coalesce((select jsonb_agg(to_jsonb(group_rows) order by group_rows.errors desc, group_rows.processing desc, group_rows.pending desc, group_rows.title) from group_rows where group_rows.total > 0), '[]'::jsonb)
  ) from totals cross join archived;
$$;

revoke all on function public.get_publication_queue_reference_summary(uuid) from public, anon;
grant execute on function public.get_publication_queue_reference_summary(uuid) to authenticated, service_role;
notify pgrst, 'reload schema';
