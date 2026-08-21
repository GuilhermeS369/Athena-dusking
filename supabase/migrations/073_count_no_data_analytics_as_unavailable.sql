-- Athena Scheduler: contabiliza snapshots sem dados como analytics pendente/indisponível no resumo.

create or replace function public.get_dashboard_analytics_summary(p_organization_id uuid)
returns table (
  connections_total integer,
  connections_healthy integer,
  connections_attention integer,
  operational_profiles integer,
  scheduled_total integer,
  next_scheduled_at timestamptz,
  failed_publications integer,
  profiles_needing_reauth integer,
  total_posts integer,
  published_total integer,
  followers_total bigint,
  followers_delta bigint,
  views_total bigint,
  reach_total bigint,
  interactions_total bigint,
  analytics_available_profiles integer,
  analytics_unavailable_profiles integer,
  ready_assets integer,
  groups_total integer
)
language sql
stable
security definer
set search_path = public
as $$
  with profile_rows as (
    select * from public.instagram_profiles profile
    where profile.organization_id = p_organization_id and profile.deleted_at is null
  ), latest_snapshots as (
    select distinct on (snapshot.profile_id) snapshot.*
    from public.profile_analytics_snapshots snapshot
    join profile_rows profile on profile.id = snapshot.profile_id
    where snapshot.organization_id = p_organization_id and snapshot.deleted_at is null
    order by snapshot.profile_id, snapshot.period_end desc, snapshot.synced_at desc nulls last, snapshot.updated_at desc
  ), publication_rows as (
    select * from public.publication_items item
    where item.organization_id = p_organization_id and item.status not in ('removed', 'cancelled', 'ignored')
  )
  select
    (select count(*)::integer from profile_rows),
    (select count(*)::integer from profile_rows where status = 'online'),
    (select count(*)::integer from profile_rows where status in ('offline', 'reauthorization_required')),
    (select count(*)::integer from profile_rows where status = 'online'),
    (select count(*)::integer from publication_rows where status in ('waiting', 'ready', 'preparing', 'publishing') and (execute_at is null or execute_at >= timezone('utc', now()))),
    (select min(execute_at) from publication_rows where status in ('waiting', 'ready', 'preparing', 'publishing') and execute_at >= timezone('utc', now())),
    (select count(*)::integer from public.publication_items item where item.organization_id = p_organization_id and item.status = 'failed'),
    (select count(*)::integer from profile_rows where status = 'reauthorization_required'),
    (select count(*)::integer from publication_rows),
    (select count(*)::integer from publication_rows where status = 'published'),
    coalesce((select sum(followers_count) from latest_snapshots), 0),
    coalesce((select sum(followers_delta) from latest_snapshots), 0),
    coalesce((select sum(views) from latest_snapshots), 0),
    coalesce((select sum(reach) from latest_snapshots), 0),
    coalesce((select sum(total_interactions) from latest_snapshots), 0),
    (select count(*)::integer from latest_snapshots where sync_status = 'synced'),
    (select count(*)::integer from latest_snapshots where sync_status in ('no_data', 'unavailable_plan', 'permission_missing', 'failed', 'not_configured')),
    (select count(*)::integer from public.media_assets asset where asset.organization_id = p_organization_id and asset.status = 'ready' and asset.deleted_at is null),
    (select count(*)::integer from public.profile_groups group_row where group_row.organization_id = p_organization_id and group_row.deleted_at is null)
  where public.is_organization_member(p_organization_id);
$$;

revoke all on function public.get_dashboard_analytics_summary(uuid) from public, anon;
grant execute on function public.get_dashboard_analytics_summary(uuid) to authenticated, service_role;
