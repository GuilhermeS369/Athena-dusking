-- Dashboard escalável — Fase F.
-- Fundação aditiva para execução live class-aware, current state compacto,
-- arquivo bruto com retenção, backfill e validação de paridade.

create table if not exists public.profile_analytics_v2_rollouts (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  live_current_enabled boolean not null default false,
  live_daily_enabled boolean not null default false,
  live_posts_enabled boolean not null default false,
  current_state_reads_enabled boolean not null default false,
  payload_archive_enabled boolean not null default true,
  legacy_fallback_enabled boolean not null default true,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.profile_analytics_payload_archives (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  profile_id uuid not null references public.instagram_profiles (id) on delete cascade,
  provider public.instagram_integration_provider not null,
  source_class text not null references public.profile_analytics_source_classes (source_class),
  sync_run_id uuid references public.profile_analytics_sync_runs (id) on delete set null,
  period_start date,
  period_end date,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  payload_sha256 text not null check (payload_sha256 ~ '^[a-f0-9]{64}$'),
  captured_at timestamptz not null default timezone('utc', now()),
  retain_until timestamptz not null default (timezone('utc', now()) + interval '90 days'),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default timezone('utc', now()),
  check (period_start is null or period_end is null or period_start <= period_end),
  check (retain_until > captured_at)
);

create index if not exists profile_analytics_payload_archives_profile_idx
  on public.profile_analytics_payload_archives (
    organization_id, profile_id, source_class, captured_at desc
  );

create index if not exists profile_analytics_payload_archives_retention_idx
  on public.profile_analytics_payload_archives (retain_until);

create table if not exists public.profile_analytics_current (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  profile_id uuid not null references public.instagram_profiles (id) on delete cascade,
  provider public.instagram_integration_provider not null,
  period_start date,
  period_end date,
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
  current_synced_at timestamptz,
  daily_synced_at timestamptz,
  posts_synced_at timestamptz,
  current_payload_archive_id uuid references public.profile_analytics_payload_archives (id) on delete set null,
  daily_payload_archive_id uuid references public.profile_analytics_payload_archives (id) on delete set null,
  posts_payload_archive_id uuid references public.profile_analytics_payload_archives (id) on delete set null,
  current_payload_sha256 text,
  daily_payload_sha256 text,
  posts_payload_sha256 text,
  deleted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, profile_id),
  check (period_start is null or period_end is null or period_start <= period_end),
  check (current_payload_sha256 is null or current_payload_sha256 ~ '^[a-f0-9]{64}$'),
  check (daily_payload_sha256 is null or daily_payload_sha256 ~ '^[a-f0-9]{64}$'),
  check (posts_payload_sha256 is null or posts_payload_sha256 ~ '^[a-f0-9]{64}$')
);

create unique index if not exists profile_analytics_payload_archives_conflict_idx
  on public.profile_analytics_payload_archives (
    organization_id, profile_id, source_class, payload_sha256, period_start, period_end
  ) nulls not distinct;

create index if not exists profile_analytics_current_org_status_idx
  on public.profile_analytics_current (organization_id, sync_status, current_synced_at desc)
  where deleted_at is null;

alter table public.profile_analytics_snapshots
  add column if not exists payload_archive_id uuid references public.profile_analytics_payload_archives (id) on delete set null,
  add column if not exists payload_sha256 text;

alter table public.profile_follower_daily_snapshots
  add column if not exists payload_archive_id uuid references public.profile_analytics_payload_archives (id) on delete set null,
  add column if not exists payload_sha256 text;

alter table public.profile_post_analytics_snapshots
  add column if not exists payload_archive_id uuid references public.profile_analytics_payload_archives (id) on delete set null,
  add column if not exists payload_sha256 text;

drop trigger if exists profile_analytics_v2_rollouts_set_updated_at
  on public.profile_analytics_v2_rollouts;
create trigger profile_analytics_v2_rollouts_set_updated_at
before update on public.profile_analytics_v2_rollouts
for each row execute function public.set_updated_at();

drop trigger if exists profile_analytics_current_set_updated_at
  on public.profile_analytics_current;
create trigger profile_analytics_current_set_updated_at
before update on public.profile_analytics_current
for each row execute function public.set_updated_at();

alter table public.profile_analytics_v2_rollouts enable row level security;
alter table public.profile_analytics_payload_archives enable row level security;
alter table public.profile_analytics_current enable row level security;

create policy profile_analytics_v2_rollouts_select_operator
on public.profile_analytics_v2_rollouts for select to authenticated
using (public.has_organization_role(organization_id, array['admin', 'operator']::public.organization_role[]));

create policy profile_analytics_current_select_member
on public.profile_analytics_current for select to authenticated
using (public.is_organization_member(organization_id));

revoke all on table
  public.profile_analytics_v2_rollouts,
  public.profile_analytics_payload_archives,
  public.profile_analytics_current
from public, anon;

grant select on table public.profile_analytics_v2_rollouts to authenticated;
grant select on table public.profile_analytics_current to authenticated;
grant select, insert, update, delete on table
  public.profile_analytics_v2_rollouts,
  public.profile_analytics_payload_archives,
  public.profile_analytics_current
to service_role;

create or replace function public.enqueue_profile_analytics_refresh_v2_live_canary(
  p_organization_id uuid,
  p_profile_ids uuid[],
  p_source_class text,
  p_canary_key text
)
returns table (
  inserted_count integer,
  total_count integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_profile_ids uuid[];
  normalized_source_class text := lower(trim(coalesce(p_source_class, '')));
  safe_canary_key text := trim(coalesce(p_canary_key, ''));
  inserted_rows integer := 0;
begin
  if not public.is_service_role_request() then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;
  if p_organization_id is null then
    raise exception using errcode = '22023', message = 'Organização do canário live é obrigatória.';
  end if;
  if normalized_source_class not in ('current', 'daily', 'posts') then
    raise exception using errcode = '22023', message = 'Classe live inválida; use current, daily ou posts.';
  end if;
  if not exists (
    select 1 from public.profile_analytics_source_classes class
    where class.source_class = normalized_source_class and class.enabled
  ) then
    raise exception using errcode = '55000', message = 'Classe de analytics desabilitada.';
  end if;
  if char_length(safe_canary_key) not between 8 and 120 then
    raise exception using errcode = '22023', message = 'Chave do canário live inválida.';
  end if;

  select coalesce(array_agg(distinct profile.id order by profile.id), '{}'::uuid[])
  into normalized_profile_ids
  from public.instagram_profiles profile
  join unnest(coalesce(p_profile_ids, '{}'::uuid[])) requested(profile_id)
    on requested.profile_id = profile.id
  where profile.organization_id = p_organization_id
    and profile.deleted_at is null
    and profile.provider = 'zernio'
    and profile.zernio_account_id is not null;

  if cardinality(normalized_profile_ids) = 0 then
    raise exception using errcode = '22023', message = 'O canário live precisa de pelo menos um perfil Zernio ativo.';
  end if;
  if cardinality(normalized_profile_ids) > 10 then
    raise exception using errcode = '22023', message = 'O canário live aceita no máximo 10 perfis por lote.';
  end if;
  if cardinality(normalized_profile_ids) <> cardinality(array(select distinct unnest(coalesce(p_profile_ids, '{}'::uuid[])))) then
    raise exception using errcode = '22023', message = 'Há perfil inválido, removido ou fora da organização no canário live.';
  end if;

  insert into public.profile_analytics_refresh_v2_connection_lanes (
    organization_id, connection_key, zernio_connection_id
  )
  select distinct
    profile.organization_id,
    coalesce(profile.zernio_connection_id::text, profile.organization_id::text || ':default'),
    profile.zernio_connection_id
  from public.instagram_profiles profile
  where profile.id = any(normalized_profile_ids)
  on conflict (organization_id, connection_key) do update
  set zernio_connection_id = coalesce(
    public.profile_analytics_refresh_v2_connection_lanes.zernio_connection_id,
    excluded.zernio_connection_id
  );

  with inserted as (
    insert into public.profile_analytics_refresh_v2_items (
      organization_id, profile_id, zernio_connection_id, connection_key,
      source_class, execution_mode, priority, estimated_requests,
      idempotency_key, max_attempts, metadata
    )
    select
      profile.organization_id,
      profile.id,
      profile.zernio_connection_id,
      coalesce(profile.zernio_connection_id::text, profile.organization_id::text || ':default'),
      normalized_source_class,
      'live',
      least(2000, class.default_priority + 1800)::smallint,
      class.default_estimated_requests,
      'live-' || normalized_source_class || '-canary:' || safe_canary_key || ':' || profile.id::text,
      3,
      jsonb_build_object(
        'canary', true,
        'canaryKey', safe_canary_key,
        'sourceClasses', jsonb_build_array(normalized_source_class)
      )
    from public.instagram_profiles profile
    join public.profile_analytics_source_classes class
      on class.source_class = normalized_source_class
     and class.enabled
    where profile.id = any(normalized_profile_ids)
    on conflict (organization_id, idempotency_key) do nothing
    returning *
  ), events as (
    insert into public.profile_analytics_refresh_v2_item_events (
      item_id, legacy_job_id, organization_id, profile_id, source_class,
      execution_mode, event_type, attempt_number, metadata
    )
    select
      inserted.id, null, inserted.organization_id, inserted.profile_id,
      inserted.source_class, inserted.execution_mode, 'enqueued', 0,
      jsonb_build_object('canary', true, 'canaryKey', safe_canary_key)
    from inserted
    returning id
  )
  select count(*)::integer into inserted_rows from events;

  inserted_count := inserted_rows;
  select count(*)::integer into total_count
  from public.profile_analytics_refresh_v2_items item
  where item.organization_id = p_organization_id
    and item.execution_mode = 'live'
    and item.source_class = normalized_source_class
    and item.idempotency_key like 'live-' || normalized_source_class || '-canary:' || safe_canary_key || ':%';
  return next;
end;
$$;

create or replace function public.claim_profile_analytics_refresh_v2_live_item(
  p_worker_id text,
  p_organization_ids uuid[],
  p_source_classes text[],
  p_lease_seconds integer default 300,
  p_max_connection_leases integer default 1
)
returns table (
  item_id uuid,
  legacy_job_id uuid,
  organization_id uuid,
  profile_id uuid,
  zernio_connection_id uuid,
  connection_key text,
  source_class text,
  execution_mode text,
  priority smallint,
  estimated_requests smallint,
  attempts integer,
  max_attempts integer,
  lease_token uuid,
  lease_until timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_classes text[];
  selected_item public.profile_analytics_refresh_v2_items%rowtype;
  was_recovered boolean := false;
begin
  if not public.is_service_role_request() then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido.';
  end if;
  if cardinality(coalesce(p_organization_ids, '{}'::uuid[])) = 0 then
    raise exception using errcode = '22023', message = 'Escopo de organizações live é obrigatório.';
  end if;
  select coalesce(array_agg(distinct lower(trim(requested.source_class))), '{}'::text[])
  into normalized_classes
  from unnest(coalesce(p_source_classes, '{}'::text[])) requested(source_class)
  where lower(trim(requested.source_class)) in ('current', 'daily', 'posts');
  if cardinality(normalized_classes) = 0
    or cardinality(normalized_classes) <> cardinality(array(select distinct lower(trim(unnest(coalesce(p_source_classes, '{}'::text[]))))))
  then
    raise exception using errcode = '22023', message = 'Classe live inválida.';
  end if;
  if p_lease_seconds not between 30 and 1800 then
    raise exception using errcode = '22023', message = 'Lease deve estar entre 30 e 1800 segundos.';
  end if;
  if p_max_connection_leases not between 1 and 5 then
    raise exception using errcode = '22023', message = 'Concorrência por conexão live deve estar entre 1 e 5.';
  end if;

  with exhausted as (
    update public.profile_analytics_refresh_v2_items item
    set status = 'dead_letter',
        claimed_by = null,
        lease_until = null,
        completed_at = timezone('utc', now()),
        last_error_class = coalesce(item.last_error_class, 'lease_exhausted'),
        last_error_code = coalesce(item.last_error_code, 'analytics_v2_live_lease_exhausted'),
        last_error_message = coalesce(item.last_error_message, 'Lease expirou após a última tentativa permitida.')
    where item.execution_mode = 'live'
      and item.source_class = any(normalized_classes)
      and item.organization_id = any(p_organization_ids)
      and item.status = 'processing'
      and item.lease_until <= timezone('utc', now())
      and item.attempts >= item.max_attempts
    returning item.*
  )
  insert into public.profile_analytics_refresh_v2_item_events (
    item_id, legacy_job_id, organization_id, profile_id, source_class,
    execution_mode, event_type, attempt_number, error_class, error_code
  )
  select exhausted.id, exhausted.legacy_job_id, exhausted.organization_id,
    exhausted.profile_id, exhausted.source_class, exhausted.execution_mode,
    'dead_lettered', exhausted.attempts,
    exhausted.last_error_class, exhausted.last_error_code
  from exhausted;

  select item.*
  into selected_item
  from public.profile_analytics_refresh_v2_items item
  join public.profile_analytics_refresh_v2_connection_lanes lane
    on lane.organization_id = item.organization_id
   and lane.connection_key = item.connection_key
  where item.execution_mode = 'live'
    and item.source_class = any(normalized_classes)
    and item.organization_id = any(p_organization_ids)
    and item.attempts < item.max_attempts
    and item.available_at <= timezone('utc', now())
    and (lane.cooldown_until is null or lane.cooldown_until <= timezone('utc', now()))
    and (
      item.status in ('pending', 'retry_pending')
      or (item.status = 'processing' and item.lease_until <= timezone('utc', now()))
    )
    and (
      select count(*)
      from public.profile_analytics_refresh_v2_items active
      where active.organization_id = item.organization_id
        and active.connection_key = item.connection_key
        and active.status = 'processing'
        and active.lease_until > timezone('utc', now())
    ) < p_max_connection_leases
  order by lane.last_claimed_at asc nulls first, item.priority desc,
    item.available_at, item.created_at, item.id
  for update of item, lane skip locked
  limit 1;

  if not found then return; end if;
  was_recovered := selected_item.status = 'processing';

  update public.profile_analytics_refresh_v2_items item
  set status = 'processing',
      attempts = item.attempts + 1,
      claimed_by = trim(p_worker_id),
      lease_token = gen_random_uuid(),
      lease_until = timezone('utc', now()) + make_interval(secs => p_lease_seconds),
      last_attempt_at = timezone('utc', now()),
      completed_at = null,
      last_error_class = null,
      last_error_code = null,
      last_error_message = null
  where item.id = selected_item.id
  returning item.* into selected_item;

  update public.profile_analytics_refresh_v2_connection_lanes lane
  set last_claimed_at = timezone('utc', now()),
      claims_count = lane.claims_count + 1
  where lane.organization_id = selected_item.organization_id
    and lane.connection_key = selected_item.connection_key;

  insert into public.profile_analytics_refresh_v2_item_events (
    item_id, legacy_job_id, organization_id, profile_id, source_class,
    execution_mode, event_type, attempt_number, worker_id, lease_token
  ) values (
    selected_item.id, selected_item.legacy_job_id, selected_item.organization_id,
    selected_item.profile_id, selected_item.source_class, selected_item.execution_mode,
    case when was_recovered then 'lease_recovered' else 'claimed' end,
    selected_item.attempts, trim(p_worker_id), selected_item.lease_token
  );

  item_id := selected_item.id;
  legacy_job_id := selected_item.legacy_job_id;
  organization_id := selected_item.organization_id;
  profile_id := selected_item.profile_id;
  zernio_connection_id := selected_item.zernio_connection_id;
  connection_key := selected_item.connection_key;
  source_class := selected_item.source_class;
  execution_mode := selected_item.execution_mode;
  priority := selected_item.priority;
  estimated_requests := selected_item.estimated_requests;
  attempts := selected_item.attempts;
  max_attempts := selected_item.max_attempts;
  lease_token := selected_item.lease_token;
  lease_until := selected_item.lease_until;
  return next;
end;
$$;

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
      current_synced_at, payload_archive_id, current_payload_sha256, deleted_at
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
      provider = excluded.provider,
      period_start = excluded.period_start,
      period_end = excluded.period_end,
      followers_count = excluded.followers_count,
      followers_delta = excluded.followers_delta,
      followers_gained = excluded.followers_gained,
      followers_lost = excluded.followers_lost,
      impressions = excluded.impressions,
      reach = excluded.reach,
      views = excluded.views,
      likes = excluded.likes,
      comments = excluded.comments,
      shares = excluded.shares,
      saves = excluded.saves,
      replies = excluded.replies,
      total_interactions = excluded.total_interactions,
      profile_links_taps = excluded.profile_links_taps,
      posts_count = excluded.posts_count,
      engagement_rate = excluded.engagement_rate,
      sync_status = excluded.sync_status,
      unavailable_reason = excluded.unavailable_reason,
      last_error_code = excluded.last_error_code,
      last_error_message = excluded.last_error_message,
      current_synced_at = excluded.current_synced_at,
      current_payload_archive_id = coalesce(excluded.current_payload_archive_id, public.profile_analytics_current.current_payload_archive_id),
      current_payload_sha256 = coalesce(excluded.current_payload_sha256, public.profile_analytics_current.current_payload_sha256),
      deleted_at = null
    returning profile_id
  )
  select
    (select count(*)::integer from upserted),
    (select max(id) from profiles),
    exists (
      select 1 from public.instagram_profiles profile
      where profile.organization_id = p_organization_id
        and profile.deleted_at is null
        and profile.id > coalesce((select max(id) from profiles), p_after_profile_id)
    )
  into processed_count, last_profile_id, has_more;
  return next;
end;
$$;

create or replace function public.audit_profile_analytics_current_parity(
  p_organization_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with latest as (
    select distinct on (snapshot.profile_id) snapshot.*
    from public.profile_analytics_snapshots snapshot
    where snapshot.organization_id = p_organization_id
      and snapshot.deleted_at is null
    order by snapshot.profile_id, snapshot.period_end desc,
      snapshot.synced_at desc nulls last, snapshot.updated_at desc
  ), compared as (
    select
      latest.profile_id,
      current.profile_id is null as missing_current,
      current.profile_id is not null and (
        current.followers_count is distinct from latest.followers_count
        or current.followers_delta is distinct from latest.followers_delta
        or current.impressions is distinct from latest.impressions
        or current.reach is distinct from latest.reach
        or current.views is distinct from latest.views
        or current.likes is distinct from latest.likes
        or current.comments is distinct from latest.comments
        or current.shares is distinct from latest.shares
        or current.saves is distinct from latest.saves
        or current.total_interactions is distinct from latest.total_interactions
        or current.engagement_rate is distinct from latest.engagement_rate
        or current.sync_status is distinct from latest.sync_status
        or current.period_start is distinct from latest.period_start
        or current.period_end is distinct from latest.period_end
      ) as metric_mismatch
    from latest
    left join public.profile_analytics_current current
      on current.organization_id = latest.organization_id
     and current.profile_id = latest.profile_id
     and current.deleted_at is null
  )
  select jsonb_build_object(
    'organization_id', p_organization_id,
    'historical_profiles', count(*),
    'current_profiles', count(*) filter (where not missing_current),
    'missing_current', count(*) filter (where missing_current),
    'metric_mismatches', count(*) filter (where metric_mismatch),
    'parity_ok', count(*) filter (where missing_current or metric_mismatch) = 0,
    'audited_at', timezone('utc', now())
  )
  from compared
  where public.is_service_role_request()
     or public.has_organization_role(p_organization_id, array['admin', 'operator']::public.organization_role[]);
$$;

create or replace function public.get_profile_analytics_latest_payload_archive(
  p_organization_id uuid,
  p_profile_id uuid,
  p_source_class text default 'current'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if not public.is_service_role_request()
    and not public.has_organization_role(p_organization_id, array['admin', 'operator']::public.organization_role[])
  then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;
  if lower(trim(coalesce(p_source_class, ''))) not in ('current', 'daily', 'posts') then
    raise exception using errcode = '22023', message = 'Classe de arquivo inválida.';
  end if;
  select jsonb_build_object(
    'id', archive.id,
    'source_class', archive.source_class,
    'period_start', archive.period_start,
    'period_end', archive.period_end,
    'payload_sha256', archive.payload_sha256,
    'captured_at', archive.captured_at,
    'retain_until', archive.retain_until,
    'payload', archive.payload
  ) into result
  from public.profile_analytics_payload_archives archive
  where archive.organization_id = p_organization_id
    and archive.profile_id = p_profile_id
    and archive.source_class = lower(trim(p_source_class))
  order by archive.captured_at desc
  limit 1;
  return result;
end;
$$;

create or replace function public.purge_expired_profile_analytics_payload_archives(
  p_limit integer default 1000
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count integer;
begin
  if not public.is_service_role_request() then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;
  if p_limit not between 1 and 10000 then
    raise exception using errcode = '22023', message = 'Limite de retenção inválido.';
  end if;
  with expired as (
    select archive.id
    from public.profile_analytics_payload_archives archive
    where archive.retain_until <= timezone('utc', now())
    order by archive.retain_until
    limit p_limit
    for update skip locked
  ), deleted as (
    delete from public.profile_analytics_payload_archives archive
    using expired
    where archive.id = expired.id
    returning archive.id
  )
  select count(*)::integer into deleted_count from deleted;
  return deleted_count;
end;
$$;

revoke all on function public.enqueue_profile_analytics_refresh_v2_live_canary(uuid, uuid[], text, text)
from public, anon, authenticated;
revoke all on function public.claim_profile_analytics_refresh_v2_live_item(text, uuid[], text[], integer, integer)
from public, anon, authenticated;
revoke all on function public.backfill_profile_analytics_current(uuid, integer, uuid)
from public, anon, authenticated;
revoke all on function public.audit_profile_analytics_current_parity(uuid)
from public, anon;
revoke all on function public.get_profile_analytics_latest_payload_archive(uuid, uuid, text)
from public, anon;
revoke all on function public.purge_expired_profile_analytics_payload_archives(integer)
from public, anon, authenticated;

grant execute on function public.enqueue_profile_analytics_refresh_v2_live_canary(uuid, uuid[], text, text)
to service_role;
grant execute on function public.claim_profile_analytics_refresh_v2_live_item(text, uuid[], text[], integer, integer)
to service_role;
grant execute on function public.backfill_profile_analytics_current(uuid, integer, uuid)
to service_role;
grant execute on function public.audit_profile_analytics_current_parity(uuid)
to authenticated, service_role;
grant execute on function public.get_profile_analytics_latest_payload_archive(uuid, uuid, text)
to authenticated, service_role;
grant execute on function public.purge_expired_profile_analytics_payload_archives(integer)
to service_role;

notify pgrst, 'reload schema';
