-- PostgreSQL não define max(uuid); calcula o cursor pela ordenação explícita.

create or replace function public.backfill_profile_analytics_current(
  p_organization_id uuid,
  p_limit integer default 500,
  p_after_profile_id uuid default null
)
returns table (
  processed_count integer,
  last_profile_id uuid,
  has_more boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_service_role_request() then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;
  if p_limit not between 1 and 2000 then
    raise exception using errcode = '22023', message = 'Lote de backfill deve estar entre 1 e 2000.';
  end if;

  with profiles as materialized (
    select profile.id
    from public.instagram_profiles profile
    where profile.organization_id = p_organization_id
      and profile.deleted_at is null
      and (p_after_profile_id is null or profile.id > p_after_profile_id)
    order by profile.id
    limit p_limit
  ), latest as materialized (
    select distinct on (snapshot.profile_id) snapshot.*
    from public.profile_analytics_snapshots snapshot
    join profiles profile on profile.id = snapshot.profile_id
    where snapshot.organization_id = p_organization_id
      and snapshot.deleted_at is null
    order by snapshot.profile_id, snapshot.period_end desc,
      snapshot.synced_at desc nulls last, snapshot.updated_at desc
  ), upserted as (
    insert into public.profile_analytics_current (
      organization_id, profile_id, provider, period_start, period_end,
      followers_count, followers_delta, followers_gained, followers_lost,
      impressions, reach, views, likes, comments, shares, saves, replies,
      total_interactions, profile_links_taps, posts_count, engagement_rate,
      sync_status, unavailable_reason, last_error_code, last_error_message,
      current_synced_at, current_payload_archive_id, current_payload_sha256, deleted_at
    )
    select
      latest.organization_id, latest.profile_id, latest.provider,
      latest.period_start, latest.period_end, latest.followers_count,
      latest.followers_delta, latest.followers_gained, latest.followers_lost,
      latest.impressions, latest.reach, latest.views, latest.likes,
      latest.comments, latest.shares, latest.saves, latest.replies,
      latest.total_interactions, latest.profile_links_taps, latest.posts_count,
      latest.engagement_rate, latest.sync_status, latest.unavailable_reason,
      latest.last_error_code, latest.last_error_message, latest.synced_at,
      latest.payload_archive_id, latest.payload_sha256, null
    from latest
    on conflict (organization_id, profile_id) do update set
      provider = excluded.provider, period_start = excluded.period_start,
      period_end = excluded.period_end, followers_count = excluded.followers_count,
      followers_delta = excluded.followers_delta, followers_gained = excluded.followers_gained,
      followers_lost = excluded.followers_lost, impressions = excluded.impressions,
      reach = excluded.reach, views = excluded.views, likes = excluded.likes,
      comments = excluded.comments, shares = excluded.shares, saves = excluded.saves,
      replies = excluded.replies, total_interactions = excluded.total_interactions,
      profile_links_taps = excluded.profile_links_taps, posts_count = excluded.posts_count,
      engagement_rate = excluded.engagement_rate, sync_status = excluded.sync_status,
      unavailable_reason = excluded.unavailable_reason, last_error_code = excluded.last_error_code,
      last_error_message = excluded.last_error_message, current_synced_at = excluded.current_synced_at,
      current_payload_archive_id = coalesce(excluded.current_payload_archive_id, public.profile_analytics_current.current_payload_archive_id),
      current_payload_sha256 = coalesce(excluded.current_payload_sha256, public.profile_analytics_current.current_payload_sha256),
      deleted_at = null
    returning profile_id
  ), cursor_row as (
    select id from profiles order by id desc limit 1
  )
  select
    (select count(*)::integer from upserted),
    (select id from cursor_row),
    exists (
      select 1 from public.instagram_profiles profile
      where profile.organization_id = p_organization_id
        and profile.deleted_at is null
        and profile.id > coalesce((select id from cursor_row), p_after_profile_id)
    )
  into processed_count, last_profile_id, has_more;
  return next;
end;
$$;

revoke all on function public.backfill_profile_analytics_current(uuid, integer, uuid)
from public, anon, authenticated;
grant execute on function public.backfill_profile_analytics_current(uuid, integer, uuid)
to service_role;

notify pgrst, 'reload schema';
