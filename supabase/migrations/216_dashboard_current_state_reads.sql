-- Dashboard escalável — Fase F.
-- Troca o bootstrap/saúde para current state apenas quando o rollout da
-- organização estiver habilitado; o snapshot histórico permanece fallback.

create or replace function public.get_dashboard_current_state_v2(
  p_organization_id uuid
)
returns table (
  profile_id uuid,
  provider public.instagram_integration_provider,
  period_start date,
  period_end date,
  followers_count bigint,
  followers_delta bigint,
  views bigint,
  reach bigint,
  impressions bigint,
  total_interactions bigint,
  engagement_rate numeric,
  sync_status public.profile_analytics_sync_status,
  unavailable_reason text,
  last_error_code text,
  synced_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    current.profile_id,
    current.provider,
    current.period_start,
    current.period_end,
    current.followers_count,
    current.followers_delta,
    current.views,
    current.reach,
    current.impressions,
    current.total_interactions,
    current.engagement_rate,
    current.sync_status,
    current.unavailable_reason,
    current.last_error_code,
    current.current_synced_at
  from public.profile_analytics_current current
  where current.organization_id = p_organization_id
    and current.deleted_at is null
    and (
      public.is_service_role_request()
      or public.is_organization_member(p_organization_id)
    );
$$;

create or replace function public.dashboard_current_state_reads_enabled(
  p_organization_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select rollout.current_state_reads_enabled
    from public.profile_analytics_v2_rollouts rollout
    where rollout.organization_id = p_organization_id
  ), false);
$$;

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
    select distinct on (snapshot.profile_id)
      snapshot.profile_id, snapshot.followers_count, snapshot.followers_delta,
      snapshot.views, snapshot.reach, snapshot.total_interactions,
      snapshot.sync_status
    from public.profile_analytics_snapshots snapshot
    join profile_rows profile on profile.id = snapshot.profile_id
    where snapshot.organization_id = p_organization_id and snapshot.deleted_at is null
    order by snapshot.profile_id, snapshot.period_end desc,
      snapshot.synced_at desc nulls last, snapshot.updated_at desc
  ), selected_state as (
    select
      current.profile_id, current.followers_count, current.followers_delta,
      current.views, current.reach, current.total_interactions,
      current.sync_status
    from public.profile_analytics_current current
    where current.organization_id = p_organization_id
      and current.deleted_at is null
      and public.dashboard_current_state_reads_enabled(p_organization_id)
    union all
    select snapshot.*
    from latest_snapshots snapshot
    where not public.dashboard_current_state_reads_enabled(p_organization_id)
  ), publication_rows as (
    select * from public.publication_items item
    where item.organization_id = p_organization_id
      and item.status not in ('removed', 'cancelled', 'ignored')
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
    coalesce((select sum(followers_count) from selected_state), 0),
    coalesce((select sum(followers_delta) from selected_state), 0),
    coalesce((select sum(views) from selected_state), 0),
    coalesce((select sum(reach) from selected_state), 0),
    coalesce((select sum(total_interactions) from selected_state), 0),
    (select count(*)::integer from selected_state where sync_status in ('synced', 'partial')),
    (select count(*)::integer from selected_state where sync_status in ('unavailable_plan', 'permission_missing', 'failed', 'not_configured')),
    (select count(*)::integer from public.media_assets asset where asset.organization_id = p_organization_id and asset.status = 'ready' and asset.deleted_at is null),
    (select count(*)::integer from public.profile_groups group_row where group_row.organization_id = p_organization_id and group_row.deleted_at is null)
  where public.is_service_role_request() or public.is_organization_member(p_organization_id);
$$;

create or replace function public.get_dashboard_bootstrap_v2(
  p_organization_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  summary_row record;
  result jsonb;
begin
  if not public.is_service_role_request()
    and not public.is_organization_member(p_organization_id)
  then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  select * into summary_row
  from public.get_dashboard_analytics_summary(p_organization_id);

  with profiles as (
    select profile.id, profile.username, profile.display_name,
      profile.provider::text as provider, profile.status::text as status
    from public.instagram_profiles profile
    where profile.organization_id = p_organization_id and profile.deleted_at is null
  ), groups as (
    select group_row.id, group_row.name,
      coalesce(jsonb_agg(member.profile_id order by member.profile_id)
        filter (where member.profile_id is not null), '[]'::jsonb) as profile_ids
    from public.profile_groups group_row
    left join public.profile_group_members member
      on member.organization_id = group_row.organization_id and member.group_id = group_row.id
    where group_row.organization_id = p_organization_id and group_row.deleted_at is null
    group by group_row.id, group_row.name
  ), latest_snapshot_state as (
    select distinct on (snapshot.profile_id)
      snapshot.profile_id, snapshot.sync_status::text as sync_status,
      snapshot.synced_at, snapshot.period_end, snapshot.last_error_code
    from public.profile_analytics_snapshots snapshot
    join profiles profile on profile.id = snapshot.profile_id
    where snapshot.organization_id = p_organization_id and snapshot.deleted_at is null
    order by snapshot.profile_id, snapshot.period_end desc,
      snapshot.synced_at desc nulls last, snapshot.updated_at desc
  ), selected_state as (
    select current.profile_id, current.sync_status::text as sync_status,
      current.current_synced_at as synced_at, current.period_end, current.last_error_code
    from public.profile_analytics_current current
    where current.organization_id = p_organization_id
      and current.deleted_at is null
      and public.dashboard_current_state_reads_enabled(p_organization_id)
    union all
    select snapshot.* from latest_snapshot_state snapshot
    where not public.dashboard_current_state_reads_enabled(p_organization_id)
  )
  select jsonb_build_object(
    'generated_at', timezone('utc', now()),
    'state_source', case when public.dashboard_current_state_reads_enabled(p_organization_id) then 'current' else 'snapshot_fallback' end,
    'profiles', coalesce((select jsonb_agg(to_jsonb(profile) order by profile.username) from profiles profile), '[]'::jsonb),
    'groups', coalesce((select jsonb_agg(to_jsonb(group_row) order by group_row.name) from groups group_row), '[]'::jsonb),
    'analytics_state', coalesce((select jsonb_agg(to_jsonb(state) order by state.profile_id) from selected_state state), '[]'::jsonb),
    'summary', jsonb_build_object(
      'connections_total', coalesce(summary_row.connections_total, 0),
      'connections_healthy', coalesce(summary_row.connections_healthy, 0),
      'connections_attention', coalesce(summary_row.connections_attention, 0),
      'operational_profiles', coalesce(summary_row.operational_profiles, 0),
      'scheduled_total', coalesce(summary_row.scheduled_total, 0),
      'next_scheduled_at', summary_row.next_scheduled_at,
      'failed_publications', coalesce(summary_row.failed_publications, 0),
      'profiles_needing_reauth', coalesce(summary_row.profiles_needing_reauth, 0),
      'total_posts', coalesce(summary_row.total_posts, 0),
      'published_total', coalesce(summary_row.published_total, 0),
      'analytics_available_profiles', coalesce(summary_row.analytics_available_profiles, 0),
      'analytics_unavailable_profiles', coalesce(summary_row.analytics_unavailable_profiles, 0),
      'ready_assets', coalesce(summary_row.ready_assets, 0),
      'groups_total', coalesce(summary_row.groups_total, 0)
    )
  ) into result;
  return result;
end;
$$;

revoke all on function public.get_dashboard_current_state_v2(uuid) from public, anon;
revoke all on function public.dashboard_current_state_reads_enabled(uuid) from public, anon;
grant execute on function public.get_dashboard_current_state_v2(uuid) to authenticated, service_role;
grant execute on function public.dashboard_current_state_reads_enabled(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
