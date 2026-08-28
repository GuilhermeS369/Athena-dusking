create table if not exists public.profile_publication_catalog_current (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  profile_id uuid not null references public.instagram_profiles (id) on delete cascade,
  published_total integer not null default 0 check (published_total >= 0),
  published_reel integer not null default 0 check (published_reel >= 0),
  published_story integer not null default 0 check (published_story >= 0),
  published_image integer not null default 0 check (published_image >= 0),
  published_carousel integer not null default 0 check (published_carousel >= 0),
  latest_published_at timestamptz,
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, profile_id)
);

create index if not exists profile_publication_catalog_posted_idx
  on public.profile_publication_catalog_current (organization_id, profile_id)
  where published_total > 0;

alter table public.profile_publication_catalog_current enable row level security;

revoke all on table public.profile_publication_catalog_current from public, anon, authenticated;
grant all on table public.profile_publication_catalog_current to service_role;

create or replace function public.refresh_profile_publication_catalog_current(
  p_organization_id uuid,
  p_profile_id uuid
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.profile_publication_catalog_current (
    organization_id,
    profile_id,
    published_total,
    published_reel,
    published_story,
    published_image,
    published_carousel,
    latest_published_at,
    updated_at
  )
  select
    p_organization_id,
    p_profile_id,
    count(*) filter (where item.status = 'published')::integer,
    count(*) filter (where item.status = 'published' and item.format = 'reel')::integer,
    count(*) filter (where item.status = 'published' and item.format = 'story')::integer,
    count(*) filter (where item.status = 'published' and item.format = 'image')::integer,
    count(*) filter (where item.status = 'published' and item.format = 'carousel')::integer,
    max(item.published_at) filter (where item.status = 'published'),
    timezone('utc', now())
  from public.publication_items item
  where item.organization_id = p_organization_id
    and item.profile_id = p_profile_id
  on conflict (organization_id, profile_id) do update
  set published_total = excluded.published_total,
      published_reel = excluded.published_reel,
      published_story = excluded.published_story,
      published_image = excluded.published_image,
      published_carousel = excluded.published_carousel,
      latest_published_at = excluded.latest_published_at,
      updated_at = excluded.updated_at;
$$;

create or replace function public.project_publication_item_to_profile_catalog()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'published' then
      perform public.refresh_profile_publication_catalog_current(new.organization_id, new.profile_id);
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.status = 'published' then
      perform public.refresh_profile_publication_catalog_current(old.organization_id, old.profile_id);
    end if;
    return old;
  end if;

  if old.status <> 'published' and new.status <> 'published' then
    return new;
  end if;

  if old.status = 'published'
    and (old.organization_id, old.profile_id) is distinct from (new.organization_id, new.profile_id) then
    perform public.refresh_profile_publication_catalog_current(old.organization_id, old.profile_id);
  end if;

  perform public.refresh_profile_publication_catalog_current(new.organization_id, new.profile_id);
  return new;
end;
$$;

drop trigger if exists publication_items_project_profile_catalog on public.publication_items;
create trigger publication_items_project_profile_catalog
after insert or update or delete on public.publication_items
for each row execute function public.project_publication_item_to_profile_catalog();

insert into public.profile_publication_catalog_current (
  organization_id,
  profile_id,
  published_total,
  published_reel,
  published_story,
  published_image,
  published_carousel,
  latest_published_at,
  updated_at
)
select
  item.organization_id,
  item.profile_id,
  count(*)::integer,
  count(*) filter (where item.format = 'reel')::integer,
  count(*) filter (where item.format = 'story')::integer,
  count(*) filter (where item.format = 'image')::integer,
  count(*) filter (where item.format = 'carousel')::integer,
  max(item.published_at),
  timezone('utc', now())
from public.publication_items item
where item.status = 'published'
group by item.organization_id, item.profile_id
on conflict (organization_id, profile_id) do update
set published_total = excluded.published_total,
    published_reel = excluded.published_reel,
    published_story = excluded.published_story,
    published_image = excluded.published_image,
    published_carousel = excluded.published_carousel,
    latest_published_at = excluded.latest_published_at,
    updated_at = excluded.updated_at;

create or replace function public.get_instagram_profiles_catalog_summary(
  p_organization_id uuid,
  p_query text default null,
  p_group_id uuid default null,
  p_status text default null,
  p_situation text default null,
  p_publication text default 'all'
)
returns table (
  total bigint,
  online bigint,
  error bigint,
  paused bigint,
  published_items bigint,
  filtered_total bigint
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with base as (
    select profile.id, profile.status::text as status, profile.last_error_message
    from public.instagram_profiles profile
    where profile.organization_id = p_organization_id
      and profile.deleted_at is null
      and public.is_organization_member(p_organization_id)
  ), filtered as (
    select profile.id
    from public.instagram_profiles profile
    left join public.profile_group_members membership
      on membership.organization_id = profile.organization_id
     and membership.profile_id = profile.id
    left join public.zernio_connections connection
      on connection.organization_id = profile.organization_id
     and connection.id = profile.zernio_connection_id
     and connection.deleted_at is null
    left join public.profile_publication_catalog_current publication
      on publication.organization_id = profile.organization_id
     and publication.profile_id = profile.id
    where profile.organization_id = p_organization_id
      and profile.deleted_at is null
      and public.is_organization_member(p_organization_id)
      and (p_group_id is null or membership.group_id = p_group_id)
      and (nullif(lower(trim(coalesce(p_status, ''))), '') is null or profile.status::text = lower(trim(p_status)))
      and (
        nullif(lower(trim(coalesce(p_situation, ''))), '') is null
        or (lower(trim(p_situation)) = 'online' and profile.status::text = 'online')
        or (lower(trim(p_situation)) = 'error' and (profile.status::text = 'reauthorization_required' or profile.last_error_message is not null))
        or (lower(trim(p_situation)) = 'paused' and profile.status::text in ('offline', 'no_data'))
      )
      and (
        coalesce(nullif(lower(trim(coalesce(p_publication, 'all'))), ''), 'all') = 'all'
        or (lower(trim(p_publication)) = 'posted' and coalesce(publication.published_total, 0) > 0)
      )
      and (
        nullif(lower(trim(coalesce(p_query, ''))), '') is null
        or lower(profile.username) like '%' || trim(leading '@' from lower(trim(p_query))) || '%'
        or lower(coalesce(profile.display_name, '')) like '%' || lower(trim(p_query)) || '%'
        or lower(coalesce(connection.label, '')) like '%' || lower(trim(p_query)) || '%'
      )
  ), publication_total as (
    select coalesce(sum(publication.published_total), 0)::bigint as value
    from public.profile_publication_catalog_current publication
    where publication.organization_id = p_organization_id
  )
  select
    count(*)::bigint,
    count(*) filter (where base.status = 'online')::bigint,
    count(*) filter (where base.status = 'reauthorization_required' or base.last_error_message is not null)::bigint,
    count(*) filter (where base.status in ('offline', 'no_data'))::bigint,
    (select value from publication_total),
    (select count(*)::bigint from filtered)
  from base;
$$;

revoke all on function public.refresh_profile_publication_catalog_current(uuid, uuid) from public, anon, authenticated;
revoke all on function public.project_publication_item_to_profile_catalog() from public, anon, authenticated;
grant execute on function public.refresh_profile_publication_catalog_current(uuid, uuid) to service_role;
grant execute on function public.project_publication_item_to_profile_catalog() to service_role;

notify pgrst, 'reload schema';
