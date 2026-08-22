-- Dashboard V2: contratos agregados, aditivos e sem payloads brutos.
-- A V1 permanece disponível durante shadow mode e rollback.

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
    select
      profile.id,
      profile.username,
      profile.display_name,
      profile.provider::text as provider,
      profile.status::text as status
    from public.instagram_profiles as profile
    where profile.organization_id = p_organization_id
      and profile.deleted_at is null
  ), groups as (
    select
      group_row.id,
      group_row.name,
      coalesce(
        jsonb_agg(member.profile_id order by member.profile_id)
          filter (where member.profile_id is not null),
        '[]'::jsonb
      ) as profile_ids
    from public.profile_groups as group_row
    left join public.profile_group_members as member
      on member.organization_id = group_row.organization_id
     and member.group_id = group_row.id
    where group_row.organization_id = p_organization_id
      and group_row.deleted_at is null
    group by group_row.id, group_row.name
  ), latest_state as (
    select distinct on (snapshot.profile_id)
      snapshot.profile_id,
      snapshot.sync_status::text as sync_status,
      snapshot.synced_at,
      snapshot.period_end,
      snapshot.last_error_code
    from public.profile_analytics_snapshots as snapshot
    join profiles as profile on profile.id = snapshot.profile_id
    where snapshot.organization_id = p_organization_id
      and snapshot.deleted_at is null
    order by
      snapshot.profile_id,
      snapshot.period_end desc,
      snapshot.synced_at desc nulls last,
      snapshot.updated_at desc
  )
  select jsonb_build_object(
    'generated_at', timezone('utc', now()),
    'profiles', coalesce((
      select jsonb_agg(to_jsonb(profile) order by profile.username)
      from profiles as profile
    ), '[]'::jsonb),
    'groups', coalesce((
      select jsonb_agg(to_jsonb(group_row) order by group_row.name)
      from groups as group_row
    ), '[]'::jsonb),
    'analytics_state', coalesce((
      select jsonb_agg(to_jsonb(state) order by state.profile_id)
      from latest_state as state
    ), '[]'::jsonb),
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

create or replace function public.get_dashboard_analytics_v2(
  p_organization_id uuid,
  p_start_date date,
  p_end_date date,
  p_profile_ids uuid[] default null,
  p_group_id uuid default null,
  p_provider text default null,
  p_metric text default 'likes',
  p_bucket text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  selected_bucket text;
  result jsonb;
begin
  if not public.is_service_role_request()
    and not public.is_organization_member(p_organization_id)
  then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  if p_start_date is null or p_end_date is null
    or p_start_date > p_end_date
    or (p_end_date - p_start_date) > 365
  then
    raise exception using errcode = '22023', message = 'Período inválido; use uma janela entre 1 e 366 dias.';
  end if;

  if p_metric not in ('likes', 'comments', 'views', 'reach', 'shares', 'saves', 'interactions') then
    raise exception using errcode = '22023', message = 'Métrica inválida.';
  end if;

  if p_provider is not null and p_provider not in ('meta_official', 'zernio') then
    raise exception using errcode = '22023', message = 'Provider inválido.';
  end if;

  if p_group_id is not null and not exists (
    select 1
    from public.profile_groups as group_row
    where group_row.id = p_group_id
      and group_row.organization_id = p_organization_id
      and group_row.deleted_at is null
  ) then
    raise exception using errcode = '22023', message = 'Grupo inválido para a organização.';
  end if;

  if p_profile_ids is not null and exists (
    select 1
    from unnest(p_profile_ids) as requested(profile_id)
    where not exists (
      select 1
      from public.instagram_profiles as profile
      where profile.id = requested.profile_id
        and profile.organization_id = p_organization_id
        and profile.deleted_at is null
    )
  ) then
    raise exception using errcode = '22023', message = 'Perfil inválido para a organização.';
  end if;

  selected_bucket := coalesce(
    p_bucket,
    case
      when (p_end_date - p_start_date) <= 30 then 'day'
      when (p_end_date - p_start_date) <= 179 then 'week'
      else 'month'
    end
  );

  if selected_bucket not in ('day', 'week', 'month') then
    raise exception using errcode = '22023', message = 'Bucket inválido.';
  end if;

  with scoped_profiles as materialized (
    select
      profile.id,
      profile.username,
      profile.display_name,
      profile.provider::text as provider
    from public.instagram_profiles as profile
    where profile.organization_id = p_organization_id
      and profile.deleted_at is null
      and (p_profile_ids is null or profile.id = any(p_profile_ids))
      and (p_provider is null or profile.provider::text = p_provider)
      and (
        p_group_id is null
        or exists (
          select 1
          from public.profile_group_members as member
          where member.organization_id = p_organization_id
            and member.group_id = p_group_id
            and member.profile_id = profile.id
        )
      )
  ), daily as materialized (
    select
      metric.profile_id,
      profile.provider,
      metric.metric_date,
      metric.posts,
      metric.impressions,
      metric.reach,
      metric.views,
      metric.likes,
      metric.comments,
      metric.shares,
      metric.saves,
      metric.interactions,
      metric.coverage_status,
      case p_metric
        when 'likes' then metric.likes
        when 'comments' then metric.comments
        when 'views' then metric.views
        when 'reach' then metric.reach
        when 'shares' then metric.shares
        when 'saves' then metric.saves
        else metric.interactions
      end as selected_metric
    from public.profile_analytics_daily_metrics as metric
    join scoped_profiles as profile on profile.id = metric.profile_id
    where metric.organization_id = p_organization_id
      and metric.metric_date between p_start_date and p_end_date
      and metric.coverage_status in ('complete', 'partial')
  ), latest_followers as (
    select distinct on (follower.profile_id)
      follower.profile_id,
      follower.followers_count,
      follower.snapshot_date
    from public.profile_follower_daily_snapshots as follower
    join scoped_profiles as profile on profile.id = follower.profile_id
    where follower.organization_id = p_organization_id
      and follower.deleted_at is null
      and follower.snapshot_date <= p_end_date
      and follower.sync_status <> 'failed'
    order by follower.profile_id, follower.snapshot_date desc, follower.synced_at desc nulls last
  ), baseline_followers as (
    select distinct on (follower.profile_id)
      follower.profile_id,
      follower.followers_count,
      follower.snapshot_date
    from public.profile_follower_daily_snapshots as follower
    join scoped_profiles as profile on profile.id = follower.profile_id
    where follower.organization_id = p_organization_id
      and follower.deleted_at is null
      and follower.snapshot_date < p_start_date
      and follower.sync_status <> 'failed'
    order by follower.profile_id, follower.snapshot_date desc, follower.synced_at desc nulls last
  ), follower_points as (
    select
      date_trunc(selected_bucket, follower.snapshot_date::timestamp)::date as bucket_date,
      follower.profile_id,
      max(follower.followers_count) as followers_count
    from public.profile_follower_daily_snapshots as follower
    join scoped_profiles as profile on profile.id = follower.profile_id
    where follower.organization_id = p_organization_id
      and follower.deleted_at is null
      and follower.snapshot_date between p_start_date and p_end_date
      and follower.sync_status <> 'failed'
    group by date_trunc(selected_bucket, follower.snapshot_date::timestamp)::date, follower.profile_id
  ), published as materialized (
    select
      item.profile_id,
      item.status::text as status,
      item.format::text as format,
      timezone('America/Sao_Paulo', item.published_at) as local_published_at
    from public.publication_items as item
    join scoped_profiles as profile on profile.id = item.profile_id
    where item.organization_id = p_organization_id
      and item.status = 'published'
      and item.published_at >= (p_start_date::timestamp at time zone 'America/Sao_Paulo')
      and item.published_at < ((p_end_date + 1)::timestamp at time zone 'America/Sao_Paulo')
  ), publication_scope as materialized (
    select
      item.profile_id,
      item.status::text as status,
      item.format::text as format,
      timezone(
        'America/Sao_Paulo',
        coalesce(item.published_at, item.execute_at, item.created_at)
      ) as local_event_at
    from public.publication_items as item
    join scoped_profiles as profile on profile.id = item.profile_id
    where item.organization_id = p_organization_id
      and item.status not in ('removed', 'cancelled', 'ignored')
      and coalesce(item.published_at, item.execute_at, item.created_at)
        >= (p_start_date::timestamp at time zone 'America/Sao_Paulo')
      and coalesce(item.published_at, item.execute_at, item.created_at)
        < ((p_end_date + 1)::timestamp at time zone 'America/Sao_Paulo')
  ), metric_series as (
    select
      date_trunc(selected_bucket, daily.metric_date::timestamp)::date as bucket_date,
      sum(daily.selected_metric)::bigint as value
    from daily
    group by date_trunc(selected_bucket, daily.metric_date::timestamp)::date
  ), post_series as (
    select
      date_trunc(selected_bucket, published.local_published_at)::date as bucket_date,
      count(*)::bigint as value
    from published
    group by date_trunc(selected_bucket, published.local_published_at)::date
  ), ranking as (
    select
      profile.id as profile_id,
      profile.username,
      profile.display_name,
      coalesce(sum(daily.selected_metric), 0)::bigint as value
    from scoped_profiles as profile
    left join daily on daily.profile_id = profile.id
    group by profile.id, profile.username, profile.display_name
    order by value desc, profile.username, profile.id
    limit 10
  ), per_source as (
    select daily.provider as label, sum(daily.selected_metric)::bigint as value
    from daily
    group by daily.provider
  ), per_group as (
    select group_row.id, group_row.name as label, sum(daily.selected_metric)::bigint as value
    from daily
    join public.profile_group_members as member
      on member.organization_id = p_organization_id
     and member.profile_id = daily.profile_id
    join public.profile_groups as group_row
      on group_row.id = member.group_id
     and group_row.organization_id = p_organization_id
     and group_row.deleted_at is null
    group by group_row.id, group_row.name
  ), status_distribution as (
    select status as label, count(*)::bigint as value
    from publication_scope
    group by status
  ), format_distribution as (
    select format as label, count(*)::bigint as value
    from publication_scope
    group by format
  ), coverage as (
    select
      count(distinct profile.id)::integer as selected_profiles,
      count(distinct daily.profile_id)::integer as profiles_with_metrics,
      count(distinct daily.profile_id) filter (where daily.coverage_status = 'partial')::integer as partial_profiles,
      min(daily.metric_date) as first_metric_date,
      max(daily.metric_date) as last_metric_date
    from scoped_profiles as profile
    left join daily on daily.profile_id = profile.id
  )
  select jsonb_build_object(
    'generated_at', timezone('utc', now()),
    'filters', jsonb_build_object(
      'start_date', p_start_date,
      'end_date', p_end_date,
      'metric', p_metric,
      'bucket', selected_bucket,
      'provider', p_provider,
      'group_id', p_group_id
    ),
    'kpis', jsonb_build_object(
      'posts', (select count(*) from published),
      'impressions', coalesce((select sum(impressions) from daily), 0),
      'reach', coalesce((select sum(reach) from daily), 0),
      'views', coalesce((select sum(views) from daily), 0),
      'likes', coalesce((select sum(likes) from daily), 0),
      'comments', coalesce((select sum(comments) from daily), 0),
      'shares', coalesce((select sum(shares) from daily), 0),
      'saves', coalesce((select sum(saves) from daily), 0),
      'interactions', coalesce((select sum(interactions) from daily), 0),
      'engagement_rate', case
        when coalesce((select sum(reach) from daily), 0) > 0
          then round((select sum(interactions) from daily)::numeric * 100 / (select sum(reach) from daily), 4)
        else 0
      end,
      'followers_total', coalesce((select sum(followers_count) from latest_followers), 0),
      'followers_delta', coalesce((
        select sum(latest.followers_count - baseline.followers_count)
        from latest_followers as latest
        join baseline_followers as baseline using (profile_id)
      ), 0),
      'followers_baseline_profiles', (select count(*) from baseline_followers)
    ),
    'metric_series', coalesce((
      select jsonb_agg(jsonb_build_object('date', bucket_date, 'value', value) order by bucket_date)
      from metric_series
    ), '[]'::jsonb),
    'post_series', coalesce((
      select jsonb_agg(jsonb_build_object('date', bucket_date, 'value', value) order by bucket_date)
      from post_series
    ), '[]'::jsonb),
    'follower_series', coalesce((
      select jsonb_agg(jsonb_build_object('date', bucket_date, 'value', value) order by bucket_date)
      from (
        select bucket_date, sum(followers_count)::bigint as value
        from follower_points
        group by bucket_date
      ) as series
    ), '[]'::jsonb),
    'metric_per_source', coalesce((
      select jsonb_agg(jsonb_build_object('label', label, 'value', value) order by label)
      from per_source
    ), '[]'::jsonb),
    'metric_per_group', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'label', label, 'value', value) order by label)
      from per_group
    ), '[]'::jsonb),
    'ranking', coalesce((
      select jsonb_agg(to_jsonb(ranking) order by value desc, username, profile_id)
      from ranking
    ), '[]'::jsonb),
    'publication_status', coalesce((
      select jsonb_agg(jsonb_build_object('label', label, 'value', value) order by label)
      from status_distribution
    ), '[]'::jsonb),
    'publication_format', coalesce((
      select jsonb_agg(jsonb_build_object('label', label, 'value', value) order by label)
      from format_distribution
    ), '[]'::jsonb),
    'coverage', (select to_jsonb(coverage) from coverage)
  ) into result;

  return result;
end;
$$;

create or replace function public.get_dashboard_top_posts_v2(
  p_organization_id uuid,
  p_start_date date,
  p_end_date date,
  p_profile_ids uuid[] default null,
  p_group_id uuid default null,
  p_provider text default null,
  p_metric text default 'interactions',
  p_limit integer default 8
)
returns table (
  id uuid,
  profile_id uuid,
  username text,
  platform_post_url text,
  content text,
  media_type text,
  thumbnail_url text,
  published_at timestamptz,
  views bigint,
  reach bigint,
  likes bigint,
  comments bigint,
  shares bigint,
  saves bigint,
  total_interactions bigint,
  engagement_rate numeric,
  sync_status text,
  metric_value bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_service_role_request()
    and not public.is_organization_member(p_organization_id)
  then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  if p_start_date is null or p_end_date is null
    or p_start_date > p_end_date
    or (p_end_date - p_start_date) > 365
  then
    raise exception using errcode = '22023', message = 'Período inválido; use uma janela entre 1 e 366 dias.';
  end if;

  if p_metric not in ('likes', 'comments', 'views', 'reach', 'shares', 'saves', 'interactions') then
    raise exception using errcode = '22023', message = 'Métrica inválida.';
  end if;

  if p_provider is not null and p_provider not in ('meta_official', 'zernio') then
    raise exception using errcode = '22023', message = 'Provider inválido.';
  end if;

  if p_limit not between 1 and 20 then
    raise exception using errcode = '22023', message = 'Limite deve estar entre 1 e 20.';
  end if;

  if p_group_id is not null and not exists (
    select 1 from public.profile_groups as group_row
    where group_row.id = p_group_id
      and group_row.organization_id = p_organization_id
      and group_row.deleted_at is null
  ) then
    raise exception using errcode = '22023', message = 'Grupo inválido para a organização.';
  end if;

  if p_profile_ids is not null and exists (
    select 1
    from unnest(p_profile_ids) as requested(profile_id)
    where not exists (
      select 1 from public.instagram_profiles as profile
      where profile.id = requested.profile_id
        and profile.organization_id = p_organization_id
        and profile.deleted_at is null
    )
  ) then
    raise exception using errcode = '22023', message = 'Perfil inválido para a organização.';
  end if;

  return query
  with scoped_profiles as (
    select profile.id, profile.username
    from public.instagram_profiles as profile
    where profile.organization_id = p_organization_id
      and profile.deleted_at is null
      and (p_profile_ids is null or profile.id = any(p_profile_ids))
      and (p_provider is null or profile.provider::text = p_provider)
      and (
        p_group_id is null
        or exists (
          select 1 from public.profile_group_members as member
          where member.organization_id = p_organization_id
            and member.group_id = p_group_id
            and member.profile_id = profile.id
        )
      )
  )
  select
    post.id,
    post.profile_id,
    profile.username,
    post.platform_post_url,
    left(post.content, 500),
    post.media_type,
    post.thumbnail_url,
    post.published_at,
    post.views,
    post.reach,
    post.likes,
    post.comments,
    post.shares,
    post.saves,
    post.total_interactions,
    post.engagement_rate,
    post.sync_status::text,
    case p_metric
      when 'likes' then post.likes
      when 'comments' then post.comments
      when 'views' then post.views
      when 'reach' then post.reach
      when 'shares' then post.shares
      when 'saves' then post.saves
      else post.total_interactions
    end as metric_value
  from public.profile_post_analytics_snapshots as post
  join scoped_profiles as profile on profile.id = post.profile_id
  where post.organization_id = p_organization_id
    and post.deleted_at is null
    and post.published_at >= (p_start_date::timestamp at time zone 'America/Sao_Paulo')
    and post.published_at < ((p_end_date + 1)::timestamp at time zone 'America/Sao_Paulo')
  order by metric_value desc, post.total_interactions desc, post.published_at desc nulls last, post.id
  limit p_limit;
end;
$$;

revoke all on function public.get_dashboard_bootstrap_v2(uuid) from public, anon;
revoke all on function public.get_dashboard_analytics_v2(uuid, date, date, uuid[], uuid, text, text, text) from public, anon;
revoke all on function public.get_dashboard_top_posts_v2(uuid, date, date, uuid[], uuid, text, text, integer) from public, anon;

grant execute on function public.get_dashboard_bootstrap_v2(uuid) to authenticated, service_role;
grant execute on function public.get_dashboard_analytics_v2(uuid, date, date, uuid[], uuid, text, text, text) to authenticated, service_role;
grant execute on function public.get_dashboard_top_posts_v2(uuid, date, date, uuid[], uuid, text, text, integer) to authenticated, service_role;

notify pgrst, 'reload schema';
