-- O pgcrypto resolve digest(bytea, text) de forma explícita neste schema.

create or replace function public.backfill_profile_analytics_current_archives(
  p_organization_id uuid,
  p_limit integer default 250,
  p_after_profile_id uuid default null
)
returns table (
  processed_count integer,
  archived_count integer,
  last_profile_id uuid,
  has_more boolean
)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.is_service_role_request() then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;
  if p_limit not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'Lote de arquivo deve estar entre 1 e 1000.';
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
  ), inserted as (
    insert into public.profile_analytics_payload_archives (
      organization_id, profile_id, provider, source_class,
      period_start, period_end, payload, payload_sha256, metadata
    )
    select
      latest.organization_id, latest.profile_id, latest.provider, 'current',
      latest.period_start, latest.period_end, latest.raw_payload,
      encode(extensions.digest(convert_to(latest.raw_payload::text, 'UTF8'), 'sha256'::text), 'hex'),
      jsonb_build_object('backfill', true, 'source', 'profile_analytics_snapshots')
    from latest
    where latest.raw_payload <> '{}'::jsonb
    on conflict (
      organization_id, profile_id, source_class,
      payload_sha256, period_start, period_end
    ) do update set
      retain_until = greatest(
        public.profile_analytics_payload_archives.retain_until,
        timezone('utc', now()) + interval '90 days'
      )
    returning id, organization_id, profile_id, payload_sha256, period_start, period_end
  ), snapshot_updated as (
    update public.profile_analytics_snapshots snapshot
    set payload_archive_id = inserted.id, payload_sha256 = inserted.payload_sha256
    from inserted
    where snapshot.organization_id = inserted.organization_id
      and snapshot.profile_id = inserted.profile_id
      and snapshot.period_start = inserted.period_start
      and snapshot.period_end = inserted.period_end
    returning snapshot.profile_id
  ), current_updated as (
    update public.profile_analytics_current current
    set current_payload_archive_id = inserted.id,
        current_payload_sha256 = inserted.payload_sha256
    from inserted
    where current.organization_id = inserted.organization_id
      and current.profile_id = inserted.profile_id
    returning current.profile_id
  ), cursor_row as (
    select id from profiles order by id desc limit 1
  )
  select
    (select count(*)::integer from latest),
    (select count(*)::integer from inserted),
    (select id from cursor_row),
    exists (
      select 1 from public.instagram_profiles profile
      where profile.organization_id = p_organization_id
        and profile.deleted_at is null
        and profile.id > coalesce((select id from cursor_row), p_after_profile_id)
    )
  into processed_count, archived_count, last_profile_id, has_more;
  return next;
end;
$$;

revoke all on function public.backfill_profile_analytics_current_archives(uuid, integer, uuid)
from public, anon, authenticated;
grant execute on function public.backfill_profile_analytics_current_archives(uuid, integer, uuid)
to service_role;

notify pgrst, 'reload schema';
