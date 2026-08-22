-- Dashboard escalável — Fase D.
-- Fila V2 aditiva por item, com fairness durável por conexão, leases independentes,
-- watermarks por fonte e execução inicial exclusivamente em shadow mode.

create table if not exists public.profile_analytics_source_classes (
  source_class text primary key check (source_class in ('current', 'daily', 'posts', 'inventory', 'backfill')),
  default_priority smallint not null check (default_priority between 0 and 2000),
  default_estimated_requests smallint not null check (default_estimated_requests between 1 and 100),
  default_stale_after_minutes integer not null check (default_stale_after_minutes between 1 and 525600),
  enabled boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

insert into public.profile_analytics_source_classes (
  source_class,
  default_priority,
  default_estimated_requests,
  default_stale_after_minutes
)
values
  ('current', 50, 2, 60),
  ('daily', 40, 1, 360),
  ('posts', 30, 2, 360),
  ('inventory', 20, 1, 1440),
  ('backfill', 10, 5, 10080)
on conflict (source_class) do update
set default_priority = excluded.default_priority,
    default_estimated_requests = excluded.default_estimated_requests,
    default_stale_after_minutes = excluded.default_stale_after_minutes,
    updated_at = timezone('utc', now());

create table if not exists public.profile_analytics_source_watermarks (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  profile_id uuid not null references public.instagram_profiles (id) on delete cascade,
  source_class text not null references public.profile_analytics_source_classes (source_class),
  last_success_at timestamptz,
  last_shadow_observed_at timestamptz,
  last_attempt_at timestamptz,
  next_refresh_at timestamptz,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  last_status text check (last_status is null or last_status in ('shadow_observed', 'succeeded', 'skipped', 'failed')),
  last_error_class text,
  source_cursor jsonb not null default '{}'::jsonb check (jsonb_typeof(source_cursor) = 'object'),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, profile_id, source_class),
  check (char_length(coalesce(last_error_class, '')) <= 80)
);

create table if not exists public.profile_analytics_refresh_v2_connection_lanes (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  connection_key text not null check (char_length(connection_key) between 1 and 180),
  zernio_connection_id uuid references public.zernio_connections (id) on delete cascade,
  last_claimed_at timestamptz,
  claims_count bigint not null default 0 check (claims_count >= 0),
  cooldown_until timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, connection_key)
);

create table if not exists public.profile_analytics_refresh_v2_items (
  id uuid primary key default gen_random_uuid(),
  legacy_job_id uuid references public.profile_analytics_refresh_jobs (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  profile_id uuid not null references public.instagram_profiles (id) on delete cascade,
  zernio_connection_id uuid references public.zernio_connections (id) on delete set null,
  connection_key text not null check (char_length(connection_key) between 1 and 180),
  source_class text not null references public.profile_analytics_source_classes (source_class),
  execution_mode text not null default 'shadow' check (execution_mode in ('shadow', 'live')),
  status text not null default 'pending' check (status in (
    'pending', 'processing', 'retry_pending', 'completed', 'skipped', 'dead_letter', 'cancelled'
  )),
  priority smallint not null default 0 check (priority between 0 and 2000),
  estimated_requests smallint not null check (estimated_requests between 1 and 100),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 500),
  available_at timestamptz not null default timezone('utc', now()),
  attempts integer not null default 0 check (attempts between 0 and 20),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  claimed_by text,
  lease_token uuid,
  lease_until timestamptz,
  last_attempt_at timestamptz,
  completed_at timestamptz,
  last_error_class text,
  last_error_code text,
  last_error_message text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (organization_id, idempotency_key),
  check (char_length(coalesce(claimed_by, '')) <= 120),
  check (char_length(coalesce(last_error_class, '')) <= 80),
  check (char_length(coalesce(last_error_code, '')) <= 160),
  check (char_length(coalesce(last_error_message, '')) <= 1200),
  check (
    (status = 'processing' and claimed_by is not null and lease_token is not null and lease_until is not null)
    or status <> 'processing'
  )
);

create table if not exists public.profile_analytics_refresh_v2_item_events (
  id bigint generated always as identity primary key,
  item_id uuid not null references public.profile_analytics_refresh_v2_items (id) on delete cascade,
  legacy_job_id uuid references public.profile_analytics_refresh_jobs (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  profile_id uuid not null references public.instagram_profiles (id) on delete cascade,
  source_class text not null references public.profile_analytics_source_classes (source_class),
  execution_mode text not null check (execution_mode in ('shadow', 'live')),
  event_type text not null check (event_type in (
    'enqueued', 'claimed', 'lease_recovered', 'shadow_observed', 'succeeded',
    'skipped', 'retry_scheduled', 'dead_lettered', 'cancelled'
  )),
  attempt_number integer not null check (attempt_number >= 0),
  worker_id text,
  lease_token uuid,
  error_class text,
  error_code text,
  duration_ms integer check (duration_ms is null or duration_ms between 0 and 3600000),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default timezone('utc', now()),
  check (char_length(coalesce(worker_id, '')) <= 120),
  check (char_length(coalesce(error_class, '')) <= 80),
  check (char_length(coalesce(error_code, '')) <= 160)
);

create index if not exists profile_analytics_refresh_v2_items_claim_idx
  on public.profile_analytics_refresh_v2_items (
    status, available_at, priority desc, organization_id, connection_key, created_at
  )
  where status in ('pending', 'processing', 'retry_pending');

create index if not exists profile_analytics_refresh_v2_items_lane_lease_idx
  on public.profile_analytics_refresh_v2_items (
    organization_id, connection_key, status, lease_until
  )
  where status = 'processing';

create index if not exists profile_analytics_refresh_v2_items_legacy_job_idx
  on public.profile_analytics_refresh_v2_items (legacy_job_id, status, source_class, created_at);

create index if not exists profile_analytics_refresh_v2_events_item_created_idx
  on public.profile_analytics_refresh_v2_item_events (item_id, created_at desc);

create index if not exists profile_analytics_refresh_v2_events_org_created_idx
  on public.profile_analytics_refresh_v2_item_events (organization_id, created_at desc);

create index if not exists profile_analytics_source_watermarks_due_idx
  on public.profile_analytics_source_watermarks (organization_id, source_class, next_refresh_at);

drop trigger if exists profile_analytics_source_classes_set_updated_at
  on public.profile_analytics_source_classes;
create trigger profile_analytics_source_classes_set_updated_at
before update on public.profile_analytics_source_classes
for each row execute function public.set_updated_at();

drop trigger if exists profile_analytics_source_watermarks_set_updated_at
  on public.profile_analytics_source_watermarks;
create trigger profile_analytics_source_watermarks_set_updated_at
before update on public.profile_analytics_source_watermarks
for each row execute function public.set_updated_at();

drop trigger if exists profile_analytics_refresh_v2_connection_lanes_set_updated_at
  on public.profile_analytics_refresh_v2_connection_lanes;
create trigger profile_analytics_refresh_v2_connection_lanes_set_updated_at
before update on public.profile_analytics_refresh_v2_connection_lanes
for each row execute function public.set_updated_at();

drop trigger if exists profile_analytics_refresh_v2_items_set_updated_at
  on public.profile_analytics_refresh_v2_items;
create trigger profile_analytics_refresh_v2_items_set_updated_at
before update on public.profile_analytics_refresh_v2_items
for each row execute function public.set_updated_at();

alter table public.profile_analytics_source_classes enable row level security;
alter table public.profile_analytics_source_watermarks enable row level security;
alter table public.profile_analytics_refresh_v2_connection_lanes enable row level security;
alter table public.profile_analytics_refresh_v2_items enable row level security;
alter table public.profile_analytics_refresh_v2_item_events enable row level security;

create policy profile_analytics_source_classes_select_authenticated
on public.profile_analytics_source_classes for select to authenticated
using (true);

create policy profile_analytics_source_watermarks_select_member
on public.profile_analytics_source_watermarks for select to authenticated
using (public.is_organization_member(organization_id));

create policy profile_analytics_refresh_v2_lanes_select_operator
on public.profile_analytics_refresh_v2_connection_lanes for select to authenticated
using (public.has_organization_role(organization_id, array['admin', 'operator']::public.organization_role[]));

create policy profile_analytics_refresh_v2_items_select_member
on public.profile_analytics_refresh_v2_items for select to authenticated
using (public.is_organization_member(organization_id));

create policy profile_analytics_refresh_v2_events_select_operator
on public.profile_analytics_refresh_v2_item_events for select to authenticated
using (public.has_organization_role(organization_id, array['admin', 'operator']::public.organization_role[]));

revoke all on table
  public.profile_analytics_source_classes,
  public.profile_analytics_source_watermarks,
  public.profile_analytics_refresh_v2_connection_lanes,
  public.profile_analytics_refresh_v2_items,
  public.profile_analytics_refresh_v2_item_events
from public, anon;

grant select on table public.profile_analytics_source_classes to authenticated;
grant select on table public.profile_analytics_source_watermarks to authenticated;
grant select on table public.profile_analytics_refresh_v2_connection_lanes to authenticated;
grant select on table public.profile_analytics_refresh_v2_items to authenticated;
grant select on table public.profile_analytics_refresh_v2_item_events to authenticated;

grant select, insert, update, delete on table
  public.profile_analytics_source_classes,
  public.profile_analytics_source_watermarks,
  public.profile_analytics_refresh_v2_connection_lanes,
  public.profile_analytics_refresh_v2_items,
  public.profile_analytics_refresh_v2_item_events
to service_role;

create or replace function public.enqueue_profile_analytics_refresh_v2_shadow_job(
  p_legacy_job_id uuid,
  p_source_classes text[] default array['current', 'daily', 'posts']::text[]
)
returns table (
  legacy_job_id uuid,
  inserted_count integer,
  total_count integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  job_row public.profile_analytics_refresh_jobs%rowtype;
  normalized_classes text[];
  inserted_rows integer := 0;
begin
  select job.* into job_row
  from public.profile_analytics_refresh_jobs job
  where job.id = p_legacy_job_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'Job legado de analytics não encontrado.';
  end if;

  if not public.is_service_role_request()
    and not public.has_organization_role(job_row.organization_id, array['admin', 'operator']::public.organization_role[])
  then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  if job_row.status in ('failed', 'cancelled') then
    raise exception using errcode = '55000', message = 'Job legado não pode originar shadow items.';
  end if;

  select coalesce(array_agg(distinct requested.source_class order by requested.source_class), '{}'::text[])
  into normalized_classes
  from unnest(coalesce(p_source_classes, '{}'::text[])) as requested(source_class)
  join public.profile_analytics_source_classes class
    on class.source_class = requested.source_class
   and class.enabled;

  if cardinality(normalized_classes) = 0
    or exists (
      select 1
      from unnest(coalesce(p_source_classes, '{}'::text[])) requested(source_class)
      where requested.source_class is null
         or not (requested.source_class = any(normalized_classes))
    )
  then
    raise exception using errcode = '22023', message = 'Classe de fonte de analytics inválida ou desabilitada.';
  end if;

  insert into public.profile_analytics_refresh_v2_connection_lanes (
    organization_id,
    connection_key,
    zernio_connection_id
  )
  select distinct
    item.organization_id,
    coalesce(item.zernio_connection_id::text, item.organization_id::text || ':default'),
    item.zernio_connection_id
  from public.profile_analytics_refresh_job_items item
  where item.job_id = p_legacy_job_id
  on conflict (organization_id, connection_key) do update
  set zernio_connection_id = coalesce(
    public.profile_analytics_refresh_v2_connection_lanes.zernio_connection_id,
    excluded.zernio_connection_id
  );

  with inserted as (
    insert into public.profile_analytics_refresh_v2_items (
      legacy_job_id,
      organization_id,
      profile_id,
      zernio_connection_id,
      connection_key,
      source_class,
      execution_mode,
      priority,
      estimated_requests,
      idempotency_key,
      metadata
    )
    select
      p_legacy_job_id,
      item.organization_id,
      item.profile_id,
      item.zernio_connection_id,
      coalesce(item.zernio_connection_id::text, item.organization_id::text || ':default'),
      class.source_class,
      'shadow',
      least(2000, class.default_priority + case job_row.trigger
        when 'manual' then 1000
        when 'connection_sync' then 800
        when 'page_view' then 500
        else 300
      end)::smallint,
      class.default_estimated_requests,
      p_legacy_job_id::text || ':' || item.profile_id::text || ':' || class.source_class || ':shadow',
      jsonb_build_object(
        'legacyItemStatus', item.status,
        'legacyTrigger', job_row.trigger,
        'shadowOnly', true
      )
    from public.profile_analytics_refresh_job_items item
    cross join unnest(normalized_classes) requested(source_class)
    join public.profile_analytics_source_classes class
      on class.source_class = requested.source_class
    where item.job_id = p_legacy_job_id
    on conflict (organization_id, idempotency_key) do nothing
    returning *
  ), events as (
    insert into public.profile_analytics_refresh_v2_item_events (
      item_id,
      legacy_job_id,
      organization_id,
      profile_id,
      source_class,
      execution_mode,
      event_type,
      attempt_number,
      metadata
    )
    select
      inserted.id,
      inserted.legacy_job_id,
      inserted.organization_id,
      inserted.profile_id,
      inserted.source_class,
      inserted.execution_mode,
      'enqueued',
      0,
      jsonb_build_object('shadowOnly', true)
    from inserted
    returning id
  )
  select count(*)::integer into inserted_rows from events;

  legacy_job_id := p_legacy_job_id;
  inserted_count := inserted_rows;
  select count(*)::integer into total_count
  from public.profile_analytics_refresh_v2_items item
  where item.legacy_job_id = p_legacy_job_id;
  return next;
end;
$$;

create or replace function public.claim_profile_analytics_refresh_v2_item(
  p_worker_id text,
  p_lease_seconds integer default 300,
  p_max_connection_leases integer default 2,
  p_execution_mode text default 'shadow'
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
  selected_item public.profile_analytics_refresh_v2_items%rowtype;
  was_recovered boolean := false;
begin
  if not public.is_service_role_request() then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido.';
  end if;
  if p_lease_seconds not between 30 and 1800 then
    raise exception using errcode = '22023', message = 'Lease deve estar entre 30 e 1800 segundos.';
  end if;
  if p_max_connection_leases not between 1 and 10 then
    raise exception using errcode = '22023', message = 'Concorrência por conexão deve estar entre 1 e 10.';
  end if;
  if p_execution_mode not in ('shadow', 'live') then
    raise exception using errcode = '22023', message = 'Modo de execução inválido.';
  end if;

  with exhausted as (
    update public.profile_analytics_refresh_v2_items item
    set status = 'dead_letter',
        claimed_by = null,
        lease_until = null,
        completed_at = timezone('utc', now()),
        last_error_class = coalesce(item.last_error_class, 'lease_exhausted'),
        last_error_code = coalesce(item.last_error_code, 'analytics_v2_lease_exhausted'),
        last_error_message = coalesce(item.last_error_message, 'Lease expirou após a última tentativa permitida.')
    where item.execution_mode = p_execution_mode
      and item.status = 'processing'
      and item.lease_until <= timezone('utc', now())
      and item.attempts >= item.max_attempts
    returning
      item.*,
      item.claimed_by as exhausted_worker_id,
      item.lease_token as exhausted_lease_token
  )
  insert into public.profile_analytics_refresh_v2_item_events (
    item_id, legacy_job_id, organization_id, profile_id, source_class,
    execution_mode, event_type, attempt_number, worker_id, lease_token,
    error_class, error_code
  )
  select exhausted.id, exhausted.legacy_job_id, exhausted.organization_id,
    exhausted.profile_id, exhausted.source_class, exhausted.execution_mode,
    'dead_lettered', exhausted.attempts, exhausted.exhausted_worker_id,
    exhausted.exhausted_lease_token, exhausted.last_error_class, exhausted.last_error_code
  from exhausted;

  select item.*
  into selected_item
  from public.profile_analytics_refresh_v2_items item
  join public.profile_analytics_refresh_v2_connection_lanes lane
    on lane.organization_id = item.organization_id
   and lane.connection_key = item.connection_key
  where item.execution_mode = p_execution_mode
    and item.attempts < item.max_attempts
    and item.available_at <= timezone('utc', now())
    and (lane.cooldown_until is null or lane.cooldown_until <= timezone('utc', now()))
    and (
      item.status = 'pending'
      or item.status = 'retry_pending'
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
  order by
    lane.last_claimed_at asc nulls first,
    item.priority desc,
    item.available_at,
    item.created_at,
    item.id
  for update of item, lane skip locked
  limit 1;

  if not found then
    return;
  end if;

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
    selected_item.profile_id, selected_item.source_class,
    selected_item.execution_mode,
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

create or replace function public.complete_profile_analytics_refresh_v2_item(
  p_item_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_outcome text,
  p_retryable boolean default false,
  p_error_class text default null,
  p_error_code text default null,
  p_error_message text default null,
  p_duration_ms integer default null,
  p_metadata jsonb default '{}'::jsonb
)
returns table (
  item_id uuid,
  status text,
  attempts integer,
  next_attempt_at timestamptz,
  idempotent boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  item_row public.profile_analytics_refresh_v2_items%rowtype;
  class_row public.profile_analytics_source_classes%rowtype;
  final_status text;
  retry_at timestamptz;
  event_name text;
begin
  if not public.is_service_role_request() then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;
  if p_outcome not in ('shadow_observed', 'succeeded', 'skipped', 'error') then
    raise exception using errcode = '22023', message = 'Resultado da fila V2 inválido.';
  end if;
  if jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) <> 'object' then
    raise exception using errcode = '22023', message = 'Metadata da fila V2 inválida.';
  end if;
  if p_duration_ms is not null and p_duration_ms not between 0 and 3600000 then
    raise exception using errcode = '22023', message = 'Duração da fila V2 inválida.';
  end if;

  select * into item_row
  from public.profile_analytics_refresh_v2_items item
  where item.id = p_item_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Item da fila V2 não encontrado.';
  end if;

  if item_row.status <> 'processing' then
    if item_row.lease_token = p_lease_token
      and item_row.claimed_by = trim(p_worker_id)
      and item_row.status in ('completed', 'skipped', 'dead_letter', 'retry_pending')
    then
      item_id := item_row.id;
      status := item_row.status;
      attempts := item_row.attempts;
      next_attempt_at := item_row.available_at;
      idempotent := true;
      return next;
      return;
    end if;
    raise exception using errcode = '55000', message = 'Item da fila V2 não está em processamento.';
  end if;

  if item_row.claimed_by is distinct from trim(p_worker_id)
    or item_row.lease_token is distinct from p_lease_token
  then
    raise exception using errcode = '55000', message = 'Lease do item V2 não pertence a este worker.';
  end if;

  if item_row.execution_mode = 'shadow' and p_outcome not in ('shadow_observed', 'error') then
    raise exception using errcode = '22023', message = 'Item shadow não pode registrar escrita analítica real.';
  end if;
  if item_row.execution_mode = 'live' and p_outcome = 'shadow_observed' then
    raise exception using errcode = '22023', message = 'Item live não pode registrar resultado shadow.';
  end if;

  if item_row.lease_until <= timezone('utc', now()) then
    raise exception using errcode = '55000', message = 'Lease do item V2 expirou.';
  end if;

  select * into class_row
  from public.profile_analytics_source_classes class
  where class.source_class = item_row.source_class;

  if p_outcome in ('shadow_observed', 'succeeded') then
    final_status := 'completed';
    retry_at := null;
    event_name := p_outcome;
  elsif p_outcome = 'skipped' then
    final_status := 'skipped';
    retry_at := null;
    event_name := 'skipped';
  elsif coalesce(p_retryable, false) and item_row.attempts < item_row.max_attempts then
    final_status := 'retry_pending';
    retry_at := timezone('utc', now()) + make_interval(
      secs => least(3600, (30 * power(2, greatest(item_row.attempts - 1, 0)))::integer + floor(random() * 16)::integer)
    );
    event_name := 'retry_scheduled';
  else
    final_status := 'dead_letter';
    retry_at := null;
    event_name := 'dead_lettered';
  end if;

  update public.profile_analytics_refresh_v2_items item
  set status = final_status,
      lease_until = null,
      available_at = coalesce(retry_at, item.available_at),
      completed_at = case when final_status in ('completed', 'skipped', 'dead_letter') then timezone('utc', now()) else null end,
      last_error_class = case when p_outcome = 'error' then nullif(left(coalesce(p_error_class, 'unknown'), 80), '') else null end,
      last_error_code = case when p_outcome = 'error' then nullif(left(coalesce(p_error_code, 'analytics_v2_failed'), 160), '') else null end,
      last_error_message = case when p_outcome = 'error' then nullif(left(coalesce(p_error_message, ''), 1200), '') else null end,
      metadata = item.metadata || coalesce(p_metadata, '{}'::jsonb)
  where item.id = item_row.id
  returning item.* into item_row;

  insert into public.profile_analytics_refresh_v2_item_events (
    item_id, legacy_job_id, organization_id, profile_id, source_class,
    execution_mode, event_type, attempt_number, worker_id, lease_token,
    error_class, error_code, duration_ms, metadata
  ) values (
    item_row.id, item_row.legacy_job_id, item_row.organization_id,
    item_row.profile_id, item_row.source_class, item_row.execution_mode,
    event_name, item_row.attempts, trim(p_worker_id), p_lease_token,
    item_row.last_error_class, item_row.last_error_code, p_duration_ms,
    coalesce(p_metadata, '{}'::jsonb)
  );

  insert into public.profile_analytics_source_watermarks (
    organization_id,
    profile_id,
    source_class,
    last_success_at,
    last_shadow_observed_at,
    last_attempt_at,
    next_refresh_at,
    consecutive_failures,
    last_status,
    last_error_class,
    metadata
  ) values (
    item_row.organization_id,
    item_row.profile_id,
    item_row.source_class,
    case when p_outcome = 'succeeded' then timezone('utc', now()) else null end,
    case when p_outcome = 'shadow_observed' then timezone('utc', now()) else null end,
    timezone('utc', now()),
    case
      when p_outcome in ('shadow_observed', 'succeeded')
        then timezone('utc', now()) + make_interval(mins => class_row.default_stale_after_minutes)
      when final_status = 'retry_pending' then retry_at
      else null
    end,
    case when p_outcome = 'error' then 1 else 0 end,
    case
      when p_outcome = 'error' then 'failed'
      else p_outcome
    end,
    item_row.last_error_class,
    coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (organization_id, profile_id, source_class) do update
  set last_success_at = coalesce(excluded.last_success_at, public.profile_analytics_source_watermarks.last_success_at),
      last_shadow_observed_at = coalesce(excluded.last_shadow_observed_at, public.profile_analytics_source_watermarks.last_shadow_observed_at),
      last_attempt_at = excluded.last_attempt_at,
      next_refresh_at = excluded.next_refresh_at,
      consecutive_failures = case
        when p_outcome = 'error' then public.profile_analytics_source_watermarks.consecutive_failures + 1
        else 0
      end,
      last_status = excluded.last_status,
      last_error_class = excluded.last_error_class,
      metadata = public.profile_analytics_source_watermarks.metadata || excluded.metadata;

  item_id := item_row.id;
  status := item_row.status;
  attempts := item_row.attempts;
  next_attempt_at := retry_at;
  idempotent := false;
  return next;
end;
$$;

revoke all on function public.enqueue_profile_analytics_refresh_v2_shadow_job(uuid, text[]) from public, anon;
revoke all on function public.claim_profile_analytics_refresh_v2_item(text, integer, integer, text) from public, anon, authenticated;
revoke all on function public.complete_profile_analytics_refresh_v2_item(uuid, text, uuid, text, boolean, text, text, text, integer, jsonb) from public, anon, authenticated;

grant execute on function public.enqueue_profile_analytics_refresh_v2_shadow_job(uuid, text[]) to authenticated, service_role;
grant execute on function public.claim_profile_analytics_refresh_v2_item(text, integer, integer, text) to service_role;
grant execute on function public.complete_profile_analytics_refresh_v2_item(uuid, text, uuid, text, boolean, text, text, text, integer, jsonb) to service_role;

notify pgrst, 'reload schema';
