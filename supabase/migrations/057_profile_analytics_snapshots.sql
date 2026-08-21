-- Athena Scheduler: snapshots e agregados locais para analytics de perfis.
-- As telas leem estes dados locais para não chamar Zernio/Meta durante renderização.

do $$
begin
  create type public.profile_analytics_sync_status as enum (
    'pending',
    'synced',
    'no_data',
    'not_configured',
    'unavailable_plan',
    'permission_missing',
    'rate_limited',
    'failed'
  );
exception when duplicate_object then null;
end $$;

create table public.profile_analytics_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  profile_id uuid not null references public.instagram_profiles (id) on delete cascade,
  provider public.instagram_integration_provider not null,
  period_start date not null,
  period_end date not null,
  followers_count bigint not null default 0 check (followers_count >= 0),
  followers_delta bigint not null default 0,
  followers_gained bigint not null default 0 check (followers_gained >= 0),
  followers_lost bigint not null default 0 check (followers_lost >= 0),
  impressions bigint not null default 0 check (impressions >= 0),
  reach bigint not null default 0 check (reach >= 0),
  views bigint not null default 0 check (views >= 0),
  likes bigint not null default 0 check (likes >= 0),
  comments bigint not null default 0 check (comments >= 0),
  shares bigint not null default 0 check (shares >= 0),
  saves bigint not null default 0 check (saves >= 0),
  replies bigint not null default 0 check (replies >= 0),
  total_interactions bigint not null default 0 check (total_interactions >= 0),
  profile_links_taps bigint not null default 0 check (profile_links_taps >= 0),
  posts_count integer not null default 0 check (posts_count >= 0),
  engagement_rate numeric(10,4) not null default 0,
  sync_status public.profile_analytics_sync_status not null default 'pending',
  unavailable_reason text,
  last_error_code text,
  last_error_message text,
  raw_payload jsonb not null default '{}'::jsonb check (jsonb_typeof(raw_payload) = 'object'),
  synced_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (period_start <= period_end),
  unique (organization_id, profile_id, provider, period_start, period_end)
);

create table public.profile_follower_daily_snapshots (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  profile_id uuid not null references public.instagram_profiles (id) on delete cascade,
  provider public.instagram_integration_provider not null,
  snapshot_date date not null,
  followers_count bigint not null default 0 check (followers_count >= 0),
  followers_gained bigint not null default 0 check (followers_gained >= 0),
  followers_lost bigint not null default 0 check (followers_lost >= 0),
  sync_status public.profile_analytics_sync_status not null default 'pending',
  raw_payload jsonb not null default '{}'::jsonb check (jsonb_typeof(raw_payload) = 'object'),
  synced_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, profile_id, provider, snapshot_date)
);

create table public.profile_post_analytics_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  profile_id uuid not null references public.instagram_profiles (id) on delete cascade,
  publication_item_id uuid references public.publication_items (id) on delete set null,
  provider public.instagram_integration_provider not null,
  zernio_post_id text,
  platform_post_id text,
  platform_post_url text,
  source text not null default 'zernio' check (source in ('athena', 'zernio', 'external')),
  status text,
  content text,
  media_type text,
  thumbnail_url text,
  published_at timestamptz,
  impressions bigint not null default 0 check (impressions >= 0),
  reach bigint not null default 0 check (reach >= 0),
  views bigint not null default 0 check (views >= 0),
  likes bigint not null default 0 check (likes >= 0),
  comments bigint not null default 0 check (comments >= 0),
  shares bigint not null default 0 check (shares >= 0),
  saves bigint not null default 0 check (saves >= 0),
  clicks bigint not null default 0 check (clicks >= 0),
  follows bigint not null default 0 check (follows >= 0),
  total_interactions bigint not null default 0 check (total_interactions >= 0),
  engagement_rate numeric(10,4) not null default 0,
  sync_status public.profile_analytics_sync_status not null default 'pending',
  last_error_message text,
  raw_payload jsonb not null default '{}'::jsonb check (jsonb_typeof(raw_payload) = 'object'),
  synced_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (zernio_post_id is not null or platform_post_id is not null or publication_item_id is not null)
);

create table public.profile_analytics_sync_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  profile_id uuid references public.instagram_profiles (id) on delete set null,
  provider public.instagram_integration_provider not null,
  sync_kind text not null check (char_length(trim(sync_kind)) between 2 and 80),
  period_start date,
  period_end date,
  status public.profile_analytics_sync_status not null default 'pending',
  skipped boolean not null default false,
  error_code text,
  error_message text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  started_at timestamptz not null default timezone('utc', now()),
  finished_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

create trigger profile_analytics_snapshots_set_updated_at
before update on public.profile_analytics_snapshots
for each row execute function public.set_updated_at();

create trigger profile_follower_daily_snapshots_set_updated_at
before update on public.profile_follower_daily_snapshots
for each row execute function public.set_updated_at();

create trigger profile_post_analytics_snapshots_set_updated_at
before update on public.profile_post_analytics_snapshots
for each row execute function public.set_updated_at();

create index profile_analytics_snapshots_profile_period_idx
  on public.profile_analytics_snapshots (organization_id, profile_id, period_end desc, synced_at desc)
  where deleted_at is null;

create index profile_analytics_snapshots_org_period_idx
  on public.profile_analytics_snapshots (organization_id, period_start, period_end)
  where deleted_at is null;

create index profile_follower_daily_snapshots_profile_date_idx
  on public.profile_follower_daily_snapshots (organization_id, profile_id, snapshot_date desc)
  where deleted_at is null;

create index profile_post_analytics_snapshots_profile_published_idx
  on public.profile_post_analytics_snapshots (organization_id, profile_id, published_at desc nulls last)
  where deleted_at is null;

create index profile_post_analytics_snapshots_zernio_post_idx
  on public.profile_post_analytics_snapshots (organization_id, zernio_post_id)
  where deleted_at is null and zernio_post_id is not null;

create unique index profile_post_analytics_snapshots_publication_item_idx
  on public.profile_post_analytics_snapshots (organization_id, publication_item_id)
  where deleted_at is null and publication_item_id is not null;

create unique index profile_post_analytics_snapshots_zernio_unique_idx
  on public.profile_post_analytics_snapshots (organization_id, zernio_post_id)
  where deleted_at is null and zernio_post_id is not null;

create index profile_analytics_sync_runs_profile_started_idx
  on public.profile_analytics_sync_runs (organization_id, profile_id, sync_kind, started_at desc)
  where deleted_at is null;

create index publication_items_org_profile_status_execute_idx
  on public.publication_items (organization_id, profile_id, status, execute_at desc);

create index publication_items_org_profile_published_idx
  on public.publication_items (organization_id, profile_id, published_at desc)
  where status = 'published';

alter table public.profile_analytics_snapshots enable row level security;
alter table public.profile_follower_daily_snapshots enable row level security;
alter table public.profile_post_analytics_snapshots enable row level security;
alter table public.profile_analytics_sync_runs enable row level security;

create policy profile_analytics_snapshots_select_member
on public.profile_analytics_snapshots for select to authenticated
using (public.is_organization_member(organization_id));

create policy profile_follower_daily_snapshots_select_member
on public.profile_follower_daily_snapshots for select to authenticated
using (public.is_organization_member(organization_id));

create policy profile_post_analytics_snapshots_select_member
on public.profile_post_analytics_snapshots for select to authenticated
using (public.is_organization_member(organization_id));

create policy profile_analytics_sync_runs_select_member
on public.profile_analytics_sync_runs for select to authenticated
using (public.is_organization_member(organization_id));

create policy profile_analytics_snapshots_mutate_operator
on public.profile_analytics_snapshots for all to authenticated
using (public.has_organization_role(organization_id, array['admin', 'operator']::public.organization_role[]))
with check (public.has_organization_role(organization_id, array['admin', 'operator']::public.organization_role[]));

create policy profile_follower_daily_snapshots_mutate_operator
on public.profile_follower_daily_snapshots for all to authenticated
using (public.has_organization_role(organization_id, array['admin', 'operator']::public.organization_role[]))
with check (public.has_organization_role(organization_id, array['admin', 'operator']::public.organization_role[]));

create policy profile_post_analytics_snapshots_mutate_operator
on public.profile_post_analytics_snapshots for all to authenticated
using (public.has_organization_role(organization_id, array['admin', 'operator']::public.organization_role[]))
with check (public.has_organization_role(organization_id, array['admin', 'operator']::public.organization_role[]));

create policy profile_analytics_sync_runs_mutate_operator
on public.profile_analytics_sync_runs for all to authenticated
using (public.has_organization_role(organization_id, array['admin', 'operator']::public.organization_role[]))
with check (public.has_organization_role(organization_id, array['admin', 'operator']::public.organization_role[]));

create or replace function public.is_service_role_request()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role';
$$;

create or replace function public.initialize_profile_analytics_state(p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  profile_row public.instagram_profiles%rowtype;
  today date := (timezone('America/Sao_Paulo', now()))::date;
begin
  select profile_source.* into profile_row
  from public.instagram_profiles as profile_source
  where profile_source.id = p_profile_id
    and profile_source.deleted_at is null;

  if not found then
    raise exception using errcode = 'P0002', message = 'Perfil não encontrado';
  end if;

  if not public.is_service_role_request()
    and not public.has_organization_role(profile_row.organization_id, array['admin', 'operator']::public.organization_role[])
  then
    raise exception using errcode = '42501', message = 'Ação não permitida';
  end if;

  insert into public.profile_analytics_snapshots (
    organization_id, profile_id, provider, period_start, period_end, sync_status, unavailable_reason, synced_at
  ) values (
    profile_row.organization_id,
    profile_row.id,
    profile_row.provider,
    today - 29,
    today,
    case when profile_row.provider = 'meta_official' then 'not_configured'::public.profile_analytics_sync_status else 'pending'::public.profile_analytics_sync_status end,
    case when profile_row.provider = 'meta_official' then 'Meta oficial ainda não tem coleta de analytics configurada no Athena.' else null end,
    timezone('utc', now())
  )
  on conflict (organization_id, profile_id, provider, period_start, period_end)
  do update set
    deleted_at = null,
    sync_status = excluded.sync_status,
    unavailable_reason = excluded.unavailable_reason,
    synced_at = coalesce(public.profile_analytics_snapshots.synced_at, excluded.synced_at);
end;
$$;

create or replace function public.soft_delete_profile_analytics(p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  profile_row public.instagram_profiles%rowtype;
  deleted_at_value timestamptz := timezone('utc', now());
begin
  select profile_source.* into profile_row
  from public.instagram_profiles as profile_source
  where profile_source.id = p_profile_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'Perfil não encontrado';
  end if;

  if not public.is_service_role_request()
    and not public.has_organization_role(profile_row.organization_id, array['admin', 'operator']::public.organization_role[])
  then
    raise exception using errcode = '42501', message = 'Ação não permitida';
  end if;

  update public.profile_analytics_snapshots set deleted_at = coalesce(deleted_at, deleted_at_value)
  where profile_id = p_profile_id and organization_id = profile_row.organization_id and deleted_at is null;

  update public.profile_follower_daily_snapshots set deleted_at = coalesce(deleted_at, deleted_at_value)
  where profile_id = p_profile_id and organization_id = profile_row.organization_id and deleted_at is null;

  update public.profile_post_analytics_snapshots set deleted_at = coalesce(deleted_at, deleted_at_value)
  where profile_id = p_profile_id and organization_id = profile_row.organization_id and deleted_at is null;

  update public.profile_analytics_sync_runs set deleted_at = coalesce(deleted_at, deleted_at_value)
  where profile_id = p_profile_id and organization_id = profile_row.organization_id and deleted_at is null;
end;
$$;

create or replace function public.get_profiles_analytics_summary(p_organization_id uuid)
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
      count(*) filter (where item.status = 'published' and item.format = 'carousel')::integer as published_carousel
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
  where profile.organization_id = p_organization_id
    and profile.deleted_at is null
    and public.is_organization_member(p_organization_id);
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
    (select count(*)::integer from latest_snapshots where sync_status in ('unavailable_plan', 'permission_missing', 'failed', 'not_configured')),
    (select count(*)::integer from public.media_assets asset where asset.organization_id = p_organization_id and asset.status = 'ready' and asset.deleted_at is null),
    (select count(*)::integer from public.profile_groups group_row where group_row.organization_id = p_organization_id and group_row.deleted_at is null)
  where public.is_organization_member(p_organization_id);
$$;

revoke all on function public.is_service_role_request() from public, anon;
revoke all on function public.initialize_profile_analytics_state(uuid) from public, anon;
revoke all on function public.soft_delete_profile_analytics(uuid) from public, anon;
revoke all on function public.get_profiles_analytics_summary(uuid) from public, anon;
revoke all on function public.get_dashboard_analytics_summary(uuid) from public, anon;

grant execute on function public.initialize_profile_analytics_state(uuid) to authenticated, service_role;
grant execute on function public.soft_delete_profile_analytics(uuid) to authenticated, service_role;
grant execute on function public.get_profiles_analytics_summary(uuid) to authenticated, service_role;
grant execute on function public.get_dashboard_analytics_summary(uuid) to authenticated, service_role;

grant select, insert, update, delete on table public.profile_analytics_snapshots to authenticated;
grant select, insert, update, delete on table public.profile_follower_daily_snapshots to authenticated;
grant select, insert, update, delete on table public.profile_post_analytics_snapshots to authenticated;
grant select, insert, update, delete on table public.profile_analytics_sync_runs to authenticated;
