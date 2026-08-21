drop function if exists public.get_profiles_analytics_summary(uuid);

create function public.get_profiles_analytics_summary(p_organization_id uuid)
returns table (
  profile_id uuid,
  scheduled_total integer,
  scheduled_reel integer,
  scheduled_story integer,
  scheduled_image integer,
  scheduled_carousel integer,
  published_total integer,
  published_reel integer,
  published_story integer,
  published_image integer,
  published_carousel integer,
  followers_count bigint,
  followers_delta bigint,
  views bigint,
  reach bigint,
  impressions bigint,
  total_interactions bigint,
  engagement_rate numeric,
  posts_count integer,
  latest_published_at timestamptz,
  analytics_status public.profile_analytics_sync_status,
  analytics_unavailable_reason text,
  analytics_synced_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with publication_metrics as (
    select
      item.profile_id,
      count(*) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing') and (item.execute_at is null or item.execute_at > timezone('utc', now())))::integer as scheduled_total,
      count(*) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing') and item.format = 'reel' and (item.execute_at is null or item.execute_at > timezone('utc', now())))::integer as scheduled_reel,
      count(*) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing') and item.format = 'story' and (item.execute_at is null or item.execute_at > timezone('utc', now())))::integer as scheduled_story,
      count(*) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing') and item.format = 'image' and (item.execute_at is null or item.execute_at > timezone('utc', now())))::integer as scheduled_image,
      count(*) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing') and item.format = 'carousel' and (item.execute_at is null or item.execute_at > timezone('utc', now())))::integer as scheduled_carousel,
      count(*) filter (where item.status = 'published')::integer as published_total,
      count(*) filter (where item.status = 'published' and item.format = 'reel')::integer as published_reel,
      count(*) filter (where item.status = 'published' and item.format = 'story')::integer as published_story,
      count(*) filter (where item.status = 'published' and item.format = 'image')::integer as published_image,
      count(*) filter (where item.status = 'published' and item.format = 'carousel')::integer as published_carousel,
      max(item.published_at) filter (where item.status = 'published') as latest_published_at
    from public.publication_items item
    where item.organization_id = p_organization_id
      and item.status in ('waiting', 'ready', 'preparing', 'publishing', 'published')
    group by item.profile_id
  )
  select
    profile.id,
    coalesce(metrics.scheduled_total, 0),
    coalesce(metrics.scheduled_reel, 0),
    coalesce(metrics.scheduled_story, 0),
    coalesce(metrics.scheduled_image, 0),
    coalesce(metrics.scheduled_carousel, 0),
    coalesce(metrics.published_total, 0),
    coalesce(metrics.published_reel, 0),
    coalesce(metrics.published_story, 0),
    coalesce(metrics.published_image, 0),
    coalesce(metrics.published_carousel, 0),
    coalesce(snapshot.followers_count, 0),
    coalesce(snapshot.followers_delta, 0),
    coalesce(snapshot.views, 0),
    coalesce(snapshot.reach, 0),
    coalesce(snapshot.impressions, 0),
    coalesce(snapshot.total_interactions, 0),
    coalesce(snapshot.engagement_rate, 0),
    greatest(coalesce(snapshot.posts_count, 0), coalesce(metrics.published_total, 0))::integer,
    coalesce(post_snapshot.latest_published_at, metrics.latest_published_at),
    coalesce(snapshot.sync_status, 'pending'::public.profile_analytics_sync_status),
    snapshot.unavailable_reason,
    snapshot.synced_at
  from public.instagram_profiles profile
  left join publication_metrics metrics on metrics.profile_id = profile.id
  left join lateral (
    select snapshot_source.*
    from public.profile_analytics_snapshots snapshot_source
    where snapshot_source.organization_id = profile.organization_id
      and snapshot_source.profile_id = profile.id
      and snapshot_source.deleted_at is null
    order by snapshot_source.period_end desc, snapshot_source.synced_at desc nulls last, snapshot_source.updated_at desc
    limit 1
  ) snapshot on true
  left join lateral (
    select max(post_source.published_at) as latest_published_at
    from public.profile_post_analytics_snapshots post_source
    where post_source.organization_id = profile.organization_id
      and post_source.profile_id = profile.id
      and post_source.deleted_at is null
  ) post_snapshot on true
  where profile.organization_id = p_organization_id
    and profile.deleted_at is null
    and public.is_organization_member(p_organization_id);
$$;

drop function if exists public.create_profile_analytics_refresh_job(uuid, text, uuid[], integer, integer);

create function public.create_profile_analytics_refresh_job(
  p_organization_id uuid,
  p_trigger text default 'manual',
  p_profile_ids uuid[] default null,
  p_stale_after_minutes integer default 60,
  p_manual_cooldown_seconds integer default 300,
  p_force boolean default false
)
returns table (
  job_id uuid,
  status text,
  total_count integer,
  reused boolean,
  reason text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_trigger text := coalesce(nullif(trim(p_trigger), ''), 'manual');
  stale_minutes integer := least(greatest(coalesce(p_stale_after_minutes, 60), 5), 10080);
  cooldown_seconds integer := least(greatest(coalesce(p_manual_cooldown_seconds, 300), 30), 3600);
  active_job public.profile_analytics_refresh_jobs%rowtype;
  recent_job public.profile_analytics_refresh_jobs%rowtype;
  new_job public.profile_analytics_refresh_jobs%rowtype;
  profile_ids uuid[] := case when p_profile_ids is null then null else array(select distinct unnest(p_profile_ids)) end;
begin
  if normalized_trigger not in ('page_view', 'manual', 'connection_sync', 'worker') then
    raise exception using errcode = '22023', message = 'Trigger de refresh inválido.';
  end if;

  if coalesce(auth.role(), '') <> 'service_role' then
    if not public.is_organization_member(p_organization_id) then
      raise exception using errcode = '42501', message = 'Ação não permitida.';
    end if;
    if normalized_trigger in ('manual', 'connection_sync') and not public.has_organization_role(p_organization_id, array['admin', 'operator']::public.organization_role[]) then
      raise exception using errcode = '42501', message = 'Ação não permitida.';
    end if;
  end if;

  select * into active_job
  from public.profile_analytics_refresh_jobs job
  where job.organization_id = p_organization_id
    and job.status in ('pending', 'processing')
    and (job.lease_until is null or job.lease_until > timezone('utc', now()) or job.status = 'pending')
  order by job.created_at desc
  limit 1;

  if found then
    job_id := active_job.id;
    status := active_job.status;
    total_count := active_job.total_count;
    reused := true;
    reason := 'active_job';
    return next;
    return;
  end if;

  if normalized_trigger = 'manual' and not coalesce(p_force, false) then
    select * into recent_job
    from public.profile_analytics_refresh_jobs job
    where job.organization_id = p_organization_id
      and job.trigger = 'manual'
      and job.created_at > timezone('utc', now()) - make_interval(secs => cooldown_seconds)
    order by job.created_at desc
    limit 1;

    if found then
      job_id := recent_job.id;
      status := recent_job.status;
      total_count := recent_job.total_count;
      reused := true;
      reason := 'manual_cooldown';
      return next;
      return;
    end if;
  end if;

  insert into public.profile_analytics_refresh_jobs (
    organization_id,
    requested_by,
    requested_by_email,
    trigger,
    status,
    stale_after_minutes,
    metadata
  ) values (
    p_organization_id,
    case when coalesce(auth.role(), '') = 'service_role' then null else auth.uid() end,
    case when coalesce(auth.role(), '') = 'service_role' then null else nullif(auth.jwt() ->> 'email', '') end,
    normalized_trigger,
    'pending',
    stale_minutes,
    jsonb_build_object('profileIdsRequested', coalesce(cardinality(profile_ids), 0), 'force', coalesce(p_force, false))
  )
  returning * into new_job;

  insert into public.profile_analytics_refresh_job_items (job_id, organization_id, profile_id, zernio_connection_id)
  select new_job.id, p_organization_id, profile.id, profile.zernio_connection_id
  from public.instagram_profiles profile
  left join lateral (
    select snapshot.synced_at, snapshot.sync_status
    from public.profile_analytics_snapshots snapshot
    where snapshot.organization_id = profile.organization_id
      and snapshot.profile_id = profile.id
      and snapshot.deleted_at is null
    order by snapshot.period_end desc, snapshot.synced_at desc nulls last, snapshot.updated_at desc
    limit 1
  ) latest_snapshot on true
  where profile.organization_id = p_organization_id
    and profile.provider = 'zernio'
    and profile.deleted_at is null
    and profile.zernio_account_id is not null
    and (profile_ids is null or profile.id = any(profile_ids))
    and (
      coalesce(p_force, false)
      or latest_snapshot.synced_at is null
      or latest_snapshot.sync_status <> 'synced'
      or latest_snapshot.synced_at < timezone('utc', now()) - make_interval(mins => stale_minutes)
    )
  order by profile.zernio_connection_id nulls last, profile.created_at;

  update public.profile_analytics_refresh_jobs job
  set total_count = (
        select count(*)::integer
        from public.profile_analytics_refresh_job_items item
        where item.job_id = new_job.id
      ),
      status = case when exists (select 1 from public.profile_analytics_refresh_job_items item where item.job_id = new_job.id) then 'pending' else 'completed' end,
      finished_at = case when exists (select 1 from public.profile_analytics_refresh_job_items item where item.job_id = new_job.id) then null else timezone('utc', now()) end
  where job.id = new_job.id
  returning job.* into new_job;

  job_id := new_job.id;
  status := new_job.status;
  total_count := new_job.total_count;
  reused := false;
  reason := case when new_job.total_count = 0 then 'nothing_stale' else 'created' end;
  return next;
exception when unique_violation then
  select * into active_job
  from public.profile_analytics_refresh_jobs job
  where job.organization_id = p_organization_id
    and job.status in ('pending', 'processing')
  order by job.created_at desc
  limit 1;

  if found then
    job_id := active_job.id;
    status := active_job.status;
    total_count := active_job.total_count;
    reused := true;
    reason := 'active_job';
    return next;
    return;
  end if;

  raise;
end;
$$;

revoke all on function public.get_profiles_analytics_summary(uuid) from public, anon;
revoke all on function public.create_profile_analytics_refresh_job(uuid, text, uuid[], integer, integer, boolean) from public, anon;
grant execute on function public.get_profiles_analytics_summary(uuid) to authenticated, service_role;
grant execute on function public.create_profile_analytics_refresh_job(uuid, text, uuid[], integer, integer, boolean) to authenticated, service_role;
