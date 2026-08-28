-- Central de observabilidade Instagram V2.
-- Camada aditiva e isolada: fontes operacionais existentes continuam
-- autoritativas durante o rollout. Eventos quentes têm retenção de 14 dias.

create type public.instagram_observability_domain as enum (
  'account', 'scheduling', 'publication', 'worker', 'connection', 'analytics', 'media'
);

create type public.instagram_observability_severity as enum (
  'info', 'warning', 'error', 'critical'
);

create type public.instagram_observability_treatment as enum (
  'action_required', 'investigating', 'auto_recovering', 'contained', 'resolved'
);

create table public.instagram_observability_incidents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  fingerprint text not null check (char_length(fingerprint) = 64),
  fingerprint_version integer not null default 1,
  domain public.instagram_observability_domain not null,
  stage text not null check (char_length(trim(stage)) between 1 and 120),
  stable_code text not null check (char_length(trim(stable_code)) between 1 and 160),
  provider text,
  worker_kind text,
  severity public.instagram_observability_severity not null,
  treatment_state public.instagram_observability_treatment not null,
  title text not null check (char_length(trim(title)) between 1 and 1000),
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  occurrence_count bigint not null default 0 check (occurrence_count >= 0),
  affected_profile_count integer not null default 0 check (affected_profile_count >= 0),
  reopen_count integer not null default 0 check (reopen_count >= 0),
  latest_countermeasure jsonb not null default '{}'::jsonb check (jsonb_typeof(latest_countermeasure) = 'object'),
  investigating_at timestamptz,
  investigating_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id) on delete set null,
  resolution_justification text,
  fix_reference text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (organization_id, fingerprint)
);

create table public.instagram_observability_events (
  id uuid not null default gen_random_uuid(),
  occurred_at timestamptz not null default timezone('utc', now()),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  incident_id uuid references public.instagram_observability_incidents(id) on delete set null,
  domain public.instagram_observability_domain not null,
  severity public.instagram_observability_severity not null default 'info',
  treatment_state public.instagram_observability_treatment not null default 'resolved',
  stage text not null check (char_length(trim(stage)) between 1 and 120),
  event_type text not null check (char_length(trim(event_type)) between 1 and 160),
  stable_code text not null check (char_length(trim(stable_code)) between 1 and 160),
  fingerprint text check (fingerprint is null or char_length(fingerprint) = 64),
  provider text,
  source_status text,
  publication_format text,
  profile_id uuid references public.instagram_profiles(id) on delete set null,
  connection_id uuid references public.zernio_connections(id) on delete set null,
  source_group_id uuid references public.profile_groups(id) on delete set null,
  batch_id uuid references public.publication_batches(id) on delete set null,
  item_id uuid references public.publication_items(id) on delete set null,
  job_id uuid,
  attempt_id uuid,
  worker_kind text,
  worker_name text,
  worker_id text,
  http_status integer check (http_status is null or http_status between 100 and 599),
  provider_code text,
  request_id text,
  post_id text,
  correlation_id text,
  source_type text not null check (char_length(trim(source_type)) between 1 and 120),
  source_id text not null check (char_length(trim(source_id)) between 1 and 400),
  message text not null check (char_length(trim(message)) between 1 and 1000),
  countermeasure jsonb not null default '{}'::jsonb check (jsonb_typeof(countermeasure) = 'object'),
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  search_document tsvector generated always as (
    to_tsvector('simple'::regconfig,
      coalesce(message, '') || ' ' || coalesce(stable_code, '') || ' ' ||
      coalesce(provider_code, '') || ' ' || coalesce(request_id, '') || ' ' ||
      coalesce(post_id, '') || ' ' || coalesce(correlation_id, '')
    )
  ) stored,
  primary key (occurred_at, id),
  unique (occurred_at, source_type, source_id)
) partition by range (occurred_at);

do $$
declare
  partition_day date;
  partition_name text;
begin
  for day_offset in -15..7 loop
    partition_day := timezone('utc', now())::date + day_offset;
    partition_name := 'instagram_observability_events_' || to_char(partition_day, 'YYYY_MM_DD');
    execute format(
      'create table if not exists public.%I partition of public.instagram_observability_events for values from (%L) to (%L)',
      partition_name,
      partition_day::timestamptz,
      (partition_day + 1)::timestamptz
    );
  end loop;
end;
$$;

create table public.instagram_observability_events_default
  partition of public.instagram_observability_events default;

create table public.instagram_observability_incident_profiles (
  incident_id uuid not null references public.instagram_observability_incidents(id) on delete cascade,
  profile_id uuid not null references public.instagram_profiles(id) on delete cascade,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  occurrence_count bigint not null default 1 check (occurrence_count > 0),
  primary key (incident_id, profile_id)
);

create table public.instagram_observability_incident_entities (
  incident_id uuid not null references public.instagram_observability_incidents(id) on delete cascade,
  entity_type text not null check (entity_type in ('connection', 'group', 'batch', 'item', 'job', 'attempt')),
  entity_id uuid not null,
  state text not null default 'active' check (state in ('active', 'recovering', 'contained', 'resolved')),
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  resolved_at timestamptz,
  occurrence_count bigint not null default 1 check (occurrence_count > 0),
  primary key (incident_id, entity_type, entity_id)
);

create table public.instagram_observability_incident_actions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  incident_id uuid not null references public.instagram_observability_incidents(id) on delete cascade,
  previous_treatment public.instagram_observability_treatment not null,
  treatment_state public.instagram_observability_treatment not null,
  justification text not null check (char_length(trim(justification)) between 8 and 1200),
  fix_reference text check (fix_reference is null or char_length(trim(fix_reference)) <= 500),
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_email text,
  created_at timestamptz not null default timezone('utc', now())
);

create table public.instagram_observability_view_preferences (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  actor_user_id uuid not null references auth.users(id) on delete cascade,
  scope_key text not null check (scope_key in (
    'account', 'publication', 'worker', 'connection', 'analytics_media', 'activity'
  )),
  cleared_at timestamptz,
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, actor_user_id, scope_key)
);

create table public.instagram_observability_rollups_5m (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  window_started_at timestamptz not null,
  domain public.instagram_observability_domain not null,
  provider text not null default 'none',
  operation text not null,
  outcome text not null,
  event_count bigint not null default 0 check (event_count >= 0),
  duration_sum_ms bigint not null default 0 check (duration_sum_ms >= 0),
  duration_min_ms integer,
  duration_max_ms integer,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, window_started_at, domain, provider, operation, outcome)
);

create table public.instagram_worker_rollups_5m (
  window_started_at timestamptz not null,
  worker_kind text not null,
  completed_cycles bigint not null default 0 check (completed_cycles >= 0),
  failed_cycles bigint not null default 0 check (failed_cycles >= 0),
  claimed_count bigint not null default 0 check (claimed_count >= 0),
  succeeded_count bigint not null default 0 check (succeeded_count >= 0),
  failed_count bigint not null default 0 check (failed_count >= 0),
  duration_sum_ms bigint not null default 0 check (duration_sum_ms >= 0),
  duration_max_ms integer,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (window_started_at, worker_kind)
);

create index instagram_observability_incidents_attention_idx
  on public.instagram_observability_incidents
  (organization_id, treatment_state, severity, last_seen_at desc, id desc);
create index instagram_observability_incidents_domain_idx
  on public.instagram_observability_incidents
  (organization_id, domain, last_seen_at desc, id desc);
create index instagram_observability_incidents_code_idx
  on public.instagram_observability_incidents
  (organization_id, stable_code, last_seen_at desc, id desc);
create index instagram_observability_events_org_time_idx
  on public.instagram_observability_events (organization_id, occurred_at desc, id desc);
create index instagram_observability_events_domain_time_idx
  on public.instagram_observability_events (organization_id, domain, occurred_at desc, id desc);
create index instagram_observability_events_profile_time_idx
  on public.instagram_observability_events (organization_id, profile_id, occurred_at desc, id desc)
  where profile_id is not null;
create index instagram_observability_events_group_time_idx
  on public.instagram_observability_events (organization_id, source_group_id, occurred_at desc, id desc)
  where source_group_id is not null;
create index instagram_observability_events_format_time_idx
  on public.instagram_observability_events (organization_id, publication_format, occurred_at desc, id desc)
  where publication_format is not null;
create index instagram_observability_events_incident_time_idx
  on public.instagram_observability_events (incident_id, occurred_at desc, id desc)
  where incident_id is not null;
create index instagram_observability_events_code_time_idx
  on public.instagram_observability_events (organization_id, stable_code, occurred_at desc, id desc);
create index instagram_observability_events_search_idx
  on public.instagram_observability_events using gin (search_document);
create index instagram_observability_incident_profiles_profile_idx
  on public.instagram_observability_incident_profiles (profile_id, last_seen_at desc, incident_id);
create index instagram_observability_incident_entities_entity_idx
  on public.instagram_observability_incident_entities (entity_type, entity_id, state, last_seen_at desc);
create index instagram_observability_rollups_window_idx
  on public.instagram_observability_rollups_5m (organization_id, window_started_at desc);
create index instagram_worker_rollups_window_idx
  on public.instagram_worker_rollups_5m (window_started_at desc, worker_kind);

create trigger instagram_observability_incidents_updated
before update on public.instagram_observability_incidents
for each row execute function public.set_updated_at();

create or replace function public.instagram_observability_severity_rank(
  p_value public.instagram_observability_severity
) returns integer language sql immutable parallel safe as $$
  select case p_value when 'critical' then 4 when 'error' then 3 when 'warning' then 2 else 1 end;
$$;

create or replace function public.instagram_observability_fingerprint(
  p_domain public.instagram_observability_domain,
  p_stage text,
  p_stable_code text,
  p_provider text default null,
  p_http_status integer default null,
  p_worker_kind text default null
) returns text language sql immutable parallel safe as $$
  select encode(extensions.digest(concat_ws('|',
    'v1', p_domain::text, lower(trim(coalesce(p_stage, 'unknown'))),
    lower(trim(coalesce(p_stable_code, 'unknown'))),
    lower(trim(coalesce(p_provider, 'none'))),
    case when p_http_status is null then 'none' else (p_http_status / 100)::text || 'xx' end,
    lower(trim(coalesce(p_worker_kind, 'none')))
  ), 'sha256'), 'hex');
$$;

create or replace function public.instagram_observability_sanitize_json(
  p_value jsonb,
  p_depth integer default 0
) returns jsonb language plpgsql immutable parallel safe as $$
declare
  result jsonb;
  entry record;
begin
  if p_value is null or p_depth > 5 then return '{}'::jsonb; end if;
  if jsonb_typeof(p_value) = 'array' then
    select coalesce(jsonb_agg(public.instagram_observability_sanitize_json(value, p_depth + 1)), '[]'::jsonb)
    into result from (select value from jsonb_array_elements(p_value) limit 30) values_limited;
    return result;
  end if;
  if jsonb_typeof(p_value) <> 'object' then return p_value; end if;
  result := '{}'::jsonb;
  for entry in select key, value from jsonb_each(p_value) loop
    if lower(entry.key) ~ '(token|secret|authorization|api.?key|signed.?url|content|caption|body|media_url|password|cookie|encrypted)' then
      continue;
    end if;
    if jsonb_typeof(entry.value) = 'string' and trim(both '"' from entry.value::text) ~* '^https?://' then
      result := result || jsonb_build_object(entry.key, '[url removida]');
    else
      result := result || jsonb_build_object(entry.key, public.instagram_observability_sanitize_json(entry.value, p_depth + 1));
    end if;
  end loop;
  if octet_length(result::text) > 16000 then
    return jsonb_build_object('truncated', true, 'reason', 'evidence_size_limit');
  end if;
  return result;
end;
$$;

create or replace function public.instagram_observability_before_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  resolved_fingerprint text;
  incident_row public.instagram_observability_incidents;
  entity_state text;
begin
  new.stage := left(lower(trim(new.stage)), 120);
  new.event_type := left(lower(trim(new.event_type)), 160);
  new.stable_code := left(lower(trim(new.stable_code)), 160);
  new.provider := nullif(left(lower(trim(coalesce(new.provider, ''))), 80), '');
  new.source_status := nullif(left(lower(trim(coalesce(new.source_status, ''))), 120), '');
  new.publication_format := nullif(left(lower(trim(coalesce(new.publication_format, ''))), 40), '');
  new.worker_kind := nullif(left(lower(trim(coalesce(new.worker_kind, ''))), 120), '');
  new.worker_name := nullif(left(trim(coalesce(new.worker_name, '')), 180), '');
  new.worker_id := nullif(left(trim(coalesce(new.worker_id, '')), 240), '');
  new.provider_code := nullif(left(lower(trim(coalesce(new.provider_code, ''))), 160), '');
  new.request_id := nullif(left(trim(coalesce(new.request_id, '')), 300), '');
  new.post_id := nullif(left(trim(coalesce(new.post_id, '')), 300), '');
  new.correlation_id := nullif(left(trim(coalesce(new.correlation_id, '')), 300), '');
  new.source_type := left(lower(trim(new.source_type)), 120);
  new.source_id := left(trim(new.source_id), 400);
  new.message := left(regexp_replace(
    regexp_replace(trim(new.message), 'https?://[^[:space:]]+', '[url removida]', 'gi'),
    'bearer[[:space:]]+[a-z0-9._~+/-]+=*', 'Bearer [removido]', 'gi'
  ), 1000);
  new.countermeasure := public.instagram_observability_sanitize_json(new.countermeasure);
  new.evidence := public.instagram_observability_sanitize_json(new.evidence);

  if new.severity = 'info' and new.treatment_state = 'resolved' then
    new.fingerprint := null;
    new.incident_id := null;
    return new;
  end if;

  resolved_fingerprint := coalesce(new.fingerprint, public.instagram_observability_fingerprint(
    new.domain, new.stage, new.stable_code, new.provider, new.http_status, new.worker_kind
  ));
  new.fingerprint := resolved_fingerprint;

  insert into public.instagram_observability_incidents (
    organization_id, fingerprint, domain, stage, stable_code, provider, worker_kind,
    severity, treatment_state, title, first_seen_at, last_seen_at, occurrence_count,
    latest_countermeasure
  ) values (
    new.organization_id, resolved_fingerprint, new.domain, new.stage, new.stable_code,
    new.provider, new.worker_kind, new.severity, new.treatment_state, new.message,
    new.occurred_at, new.occurred_at, 1, new.countermeasure
  )
  on conflict (organization_id, fingerprint) do update set
    severity = case
      when public.instagram_observability_severity_rank(excluded.severity) >=
        public.instagram_observability_severity_rank(public.instagram_observability_incidents.severity)
      then excluded.severity else public.instagram_observability_incidents.severity end,
    treatment_state = case
      when public.instagram_observability_incidents.treatment_state = 'resolved'
        and excluded.treatment_state <> 'resolved' then excluded.treatment_state
      when excluded.treatment_state = 'action_required' then 'action_required'::public.instagram_observability_treatment
      when public.instagram_observability_incidents.treatment_state = 'action_required'
        and excluded.treatment_state <> 'resolved' then public.instagram_observability_incidents.treatment_state
      else excluded.treatment_state end,
    reopen_count = public.instagram_observability_incidents.reopen_count + case
      when public.instagram_observability_incidents.treatment_state = 'resolved'
        and excluded.treatment_state <> 'resolved' then 1 else 0 end,
    last_seen_at = greatest(public.instagram_observability_incidents.last_seen_at, excluded.last_seen_at),
    occurrence_count = public.instagram_observability_incidents.occurrence_count + 1,
    title = excluded.title,
    latest_countermeasure = excluded.latest_countermeasure,
    resolved_at = case when excluded.treatment_state = 'resolved' then excluded.last_seen_at else null end,
    resolved_by = case when excluded.treatment_state = 'resolved' then public.instagram_observability_incidents.resolved_by else null end,
    resolution_justification = case when excluded.treatment_state = 'resolved' then public.instagram_observability_incidents.resolution_justification else null end,
    fix_reference = case when excluded.treatment_state = 'resolved' then public.instagram_observability_incidents.fix_reference else null end
  returning * into incident_row;

  new.incident_id := incident_row.id;

  if new.profile_id is not null then
    insert into public.instagram_observability_incident_profiles (
      incident_id, profile_id, first_seen_at, last_seen_at, occurrence_count
    ) values (incident_row.id, new.profile_id, new.occurred_at, new.occurred_at, 1)
    on conflict (incident_id, profile_id) do update set
      last_seen_at = greatest(public.instagram_observability_incident_profiles.last_seen_at, excluded.last_seen_at),
      occurrence_count = public.instagram_observability_incident_profiles.occurrence_count + 1;
    update public.instagram_observability_incidents incident
    set affected_profile_count = (
      select count(*)::integer from public.instagram_observability_incident_profiles profile
      where profile.incident_id = incident_row.id
    ) where incident.id = incident_row.id;
  end if;

  entity_state := case new.treatment_state
    when 'auto_recovering' then 'recovering'
    when 'contained' then 'contained'
    when 'resolved' then 'resolved'
    else 'active'
  end;

  insert into public.instagram_observability_incident_entities (
    incident_id, entity_type, entity_id, state, first_seen_at, last_seen_at, resolved_at
  )
  select incident_row.id, entity.entity_type, entity.entity_id, entity_state,
    new.occurred_at, new.occurred_at,
    case when entity_state = 'resolved' then new.occurred_at else null end
  from (values
    ('connection'::text, new.connection_id), ('group'::text, new.source_group_id),
    ('batch'::text, new.batch_id), ('item'::text, new.item_id),
    ('job'::text, new.job_id), ('attempt'::text, new.attempt_id)
  ) entity(entity_type, entity_id)
  where entity.entity_id is not null
  on conflict (incident_id, entity_type, entity_id) do update set
    state = excluded.state,
    last_seen_at = greatest(public.instagram_observability_incident_entities.last_seen_at, excluded.last_seen_at),
    resolved_at = excluded.resolved_at,
    occurrence_count = public.instagram_observability_incident_entities.occurrence_count + 1;

  return new;
end;
$$;

create trigger instagram_observability_events_prepare
before insert on public.instagram_observability_events
for each row execute function public.instagram_observability_before_insert();

create or replace function public.instagram_record_observability_event(
  p_organization_id uuid,
  p_domain public.instagram_observability_domain,
  p_severity public.instagram_observability_severity,
  p_treatment_state public.instagram_observability_treatment,
  p_stage text,
  p_event_type text,
  p_stable_code text,
  p_message text,
  p_source_type text,
  p_source_id text,
  p_occurred_at timestamptz default timezone('utc', now()),
  p_provider text default null,
  p_source_status text default null,
  p_publication_format text default null,
  p_profile_id uuid default null,
  p_connection_id uuid default null,
  p_source_group_id uuid default null,
  p_batch_id uuid default null,
  p_item_id uuid default null,
  p_job_id uuid default null,
  p_attempt_id uuid default null,
  p_worker_kind text default null,
  p_worker_name text default null,
  p_worker_id text default null,
  p_http_status integer default null,
  p_provider_code text default null,
  p_request_id text default null,
  p_post_id text default null,
  p_correlation_id text default null,
  p_countermeasure jsonb default '{}',
  p_evidence jsonb default '{}',
  p_fingerprint text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare inserted public.instagram_observability_events;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Apenas service_role registra observabilidade Instagram.';
  end if;
  insert into public.instagram_observability_events (
    occurred_at, organization_id, domain, severity, treatment_state, stage, event_type,
    stable_code, fingerprint, provider, source_status, publication_format, profile_id,
    connection_id, source_group_id, batch_id, item_id, job_id, attempt_id, worker_kind,
    worker_name, worker_id, http_status, provider_code, request_id, post_id, correlation_id,
    source_type, source_id, message, countermeasure, evidence
  ) values (
    coalesce(p_occurred_at, timezone('utc', now())), p_organization_id, p_domain,
    p_severity, p_treatment_state, p_stage, p_event_type, p_stable_code, p_fingerprint,
    p_provider, p_source_status, p_publication_format, p_profile_id, p_connection_id,
    p_source_group_id, p_batch_id, p_item_id, p_job_id, p_attempt_id, p_worker_kind,
    p_worker_name, p_worker_id, p_http_status, p_provider_code, p_request_id, p_post_id,
    p_correlation_id, p_source_type, p_source_id, p_message,
    coalesce(p_countermeasure, '{}'), coalesce(p_evidence, '{}')
  )
  on conflict (occurred_at, source_type, source_id) do nothing
  returning * into inserted;
  return jsonb_build_object(
    'eventId', inserted.id,
    'incidentId', inserted.incident_id,
    'occurredAt', inserted.occurred_at,
    'inserted', inserted.id is not null
  );
end;
$$;

create or replace function public.instagram_resolve_observability_entity(
  p_organization_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_resolved_at timestamptz default timezone('utc', now())
) returns integer language plpgsql security definer set search_path = public as $$
declare changed integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Apenas service_role resolve entidades operacionais.';
  end if;
  update public.instagram_observability_incident_entities entity
  set state = 'resolved', resolved_at = coalesce(p_resolved_at, timezone('utc', now())),
      last_seen_at = greatest(entity.last_seen_at, coalesce(p_resolved_at, timezone('utc', now())))
  from public.instagram_observability_incidents incident
  where incident.id = entity.incident_id
    and incident.organization_id = p_organization_id
    and entity.entity_type = p_entity_type
    and entity.entity_id = p_entity_id
    and entity.state <> 'resolved';
  get diagnostics changed = row_count;

  update public.instagram_observability_incidents incident
  set treatment_state = 'resolved', resolved_at = coalesce(p_resolved_at, timezone('utc', now()))
  where incident.organization_id = p_organization_id
    and incident.treatment_state <> 'resolved'
    and exists (
      select 1 from public.instagram_observability_incident_entities entity
      where entity.incident_id = incident.id
        and entity.entity_type = p_entity_type and entity.entity_id = p_entity_id
    )
    and not exists (
      select 1 from public.instagram_observability_incident_entities entity
      where entity.incident_id = incident.id and entity.state <> 'resolved'
    );
  return changed;
end;
$$;

create or replace function public.instagram_set_observability_incident_status(
  p_incident_id uuid,
  p_treatment_state public.instagram_observability_treatment,
  p_justification text,
  p_fix_reference text default null
) returns public.instagram_observability_incidents
language plpgsql security definer set search_path = public as $$
declare
  incident public.instagram_observability_incidents;
  previous public.instagram_observability_treatment;
  actor_email text;
begin
  select * into incident from public.instagram_observability_incidents where id = p_incident_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Incidente Instagram não encontrado.'; end if;
  if not public.has_organization_role(incident.organization_id, array['admin','operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Permissão insuficiente.';
  end if;
  if p_treatment_state not in ('investigating', 'resolved') then
    raise exception using errcode = '22023', message = 'Tratamento manual inválido.';
  end if;
  if char_length(trim(coalesce(p_justification, ''))) < 8 then
    raise exception using errcode = '22023', message = 'Justificativa deve ter ao menos 8 caracteres.';
  end if;
  previous := incident.treatment_state;
  select email into actor_email from auth.users where id = auth.uid();
  update public.instagram_observability_incidents set
    treatment_state = p_treatment_state,
    investigating_at = case when p_treatment_state = 'investigating' then timezone('utc', now()) else investigating_at end,
    investigating_by = case when p_treatment_state = 'investigating' then auth.uid() else investigating_by end,
    resolved_at = case when p_treatment_state = 'resolved' then timezone('utc', now()) else null end,
    resolved_by = case when p_treatment_state = 'resolved' then auth.uid() else null end,
    resolution_justification = case when p_treatment_state = 'resolved' then trim(p_justification) else null end,
    fix_reference = case when p_treatment_state = 'resolved' then nullif(trim(coalesce(p_fix_reference, '')), '') else null end
  where id = incident.id returning * into incident;
  insert into public.instagram_observability_incident_actions (
    organization_id, incident_id, previous_treatment, treatment_state, justification,
    fix_reference, actor_user_id, actor_email
  ) values (
    incident.organization_id, incident.id, previous, p_treatment_state, trim(p_justification),
    nullif(trim(coalesce(p_fix_reference, '')), ''), auth.uid(), actor_email
  );
  return incident;
end;
$$;

create or replace function public.instagram_set_observability_view_preference(
  p_organization_id uuid,
  p_scope_key text,
  p_action text
) returns public.instagram_observability_view_preferences
language plpgsql security definer set search_path = public as $$
declare preference public.instagram_observability_view_preferences;
begin
  if not public.is_organization_member(p_organization_id) then
    raise exception using errcode = '42501', message = 'Permissão insuficiente.';
  end if;
  if p_scope_key not in ('account','publication','worker','connection','analytics_media','activity')
    or p_action not in ('clear','undo') then
    raise exception using errcode = '22023', message = 'Preferência de logs Instagram inválida.';
  end if;
  insert into public.instagram_observability_view_preferences (
    organization_id, actor_user_id, scope_key, cleared_at
  ) values (
    p_organization_id, auth.uid(), p_scope_key,
    case when p_action = 'clear' then timezone('utc', now()) else null end
  ) on conflict (organization_id, actor_user_id, scope_key) do update set
    cleared_at = excluded.cleared_at, updated_at = timezone('utc', now())
  returning * into preference;
  return preference;
end;
$$;

create or replace function public.get_instagram_observability_summary(
  p_organization_id uuid
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare result jsonb;
begin
  if not public.is_organization_member(p_organization_id) then
    raise exception using errcode = '42501', message = 'Permissão insuficiente.';
  end if;
  with active_incidents as (
    select * from public.instagram_observability_incidents
    where organization_id = p_organization_id
      and treatment_state <> 'resolved'
  ), worker_kinds as (
    select unnest(array['publication','publication_planner','media_deletion','profile_analytics','zernio_sync']) as worker_kind
  ), worker_latest as (
    select kind.worker_kind,
      max(heartbeat.last_seen_at) as last_seen_at,
      (array_agg(heartbeat.status order by heartbeat.last_seen_at desc) filter (where heartbeat.status is not null))[1] as status
    from worker_kinds kind
    left join public.publication_worker_heartbeats heartbeat on heartbeat.worker_kind = kind.worker_kind
    group by kind.worker_kind
  )
  select jsonb_build_object(
    'incidents', jsonb_build_object(
      'actionRequired', (select count(*) from active_incidents where treatment_state = 'action_required'),
      'investigating', (select count(*) from active_incidents where treatment_state = 'investigating'),
      'autoRecovering', (select count(*) from active_incidents where treatment_state = 'auto_recovering'),
      'contained', (select count(*) from active_incidents where treatment_state = 'contained'),
      'critical', (select count(*) from active_incidents where severity = 'critical'),
      'affectedProfiles', (select count(distinct profile.profile_id) from public.instagram_observability_incident_profiles profile join active_incidents incident on incident.id = profile.incident_id),
      'byDomain', coalesce((select jsonb_object_agg(domain::text, total) from (select domain, count(*) total from active_incidents group by domain) domains), '{}'::jsonb)
    ),
    'events24h', (select count(*) from public.instagram_observability_events event where event.organization_id = p_organization_id and event.occurred_at >= timezone('utc', now()) - interval '24 hours'),
    'workers', jsonb_build_object(
      'expected', (select count(*) from worker_latest),
      'active', (select count(*) from worker_latest where last_seen_at >= timezone('utc', now()) - interval '120 seconds' and status not in ('stopped','error')),
      'stale', (select count(*) from worker_latest where last_seen_at is null or last_seen_at < timezone('utc', now()) - interval '120 seconds' or status in ('stopped','error'))
    ),
    'checkedAt', timezone('utc', now()),
    'retentionDays', 14
  ) into result;
  return result;
end;
$$;

create or replace function public.maintain_instagram_observability(
  p_retention_days integer default 14,
  p_days_ahead integer default 7,
  p_apply_legacy boolean default false
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  retention_days integer := greatest(14, least(coalesce(p_retention_days, 14), 14));
  days_ahead integer := greatest(3, least(coalesce(p_days_ahead, 7), 31));
  cutoff timestamptz := timezone('utc', now()) - make_interval(days => retention_days);
  partition_day date;
  partition_name text;
  partition_row record;
  dropped_partitions integer := 0;
  deleted_resolved bigint := 0;
  deleted_actions bigint := 0;
  deleted_rollups bigint := 0;
  deleted_worker_rollups bigint := 0;
  deleted_default bigint := 0;
  legacy_publication_events bigint := 0;
  legacy_cycle_events bigint := 0;
  legacy_sync_logs bigint := 0;
  legacy_anomalies bigint := 0;
  legacy_request_rollups bigint := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Apenas service_role mantém a observabilidade.';
  end if;

  for day_offset in 0..days_ahead loop
    partition_day := timezone('utc', now())::date + day_offset;
    partition_name := 'instagram_observability_events_' || to_char(partition_day, 'YYYY_MM_DD');
    if to_regclass('public.' || partition_name) is null then
      execute format(
        'create table public.%I partition of public.instagram_observability_events for values from (%L) to (%L)',
        partition_name, partition_day::timestamptz, (partition_day + 1)::timestamptz
      );
    end if;
  end loop;

  for partition_row in
    select child.relname as partition_name,
      to_date(substring(child.relname from '([0-9]{4}_[0-9]{2}_[0-9]{2})$'), 'YYYY_MM_DD') as partition_date
    from pg_inherits inheritance
    join pg_class parent on parent.oid = inheritance.inhparent
    join pg_class child on child.oid = inheritance.inhrelid
    join pg_namespace namespace on namespace.oid = child.relnamespace
    where parent.relname = 'instagram_observability_events'
      and namespace.nspname = 'public'
      and child.relname ~ '^instagram_observability_events_[0-9]{4}_[0-9]{2}_[0-9]{2}$'
  loop
    if partition_row.partition_date < cutoff::date then
      execute format('drop table public.%I', partition_row.partition_name);
      dropped_partitions := dropped_partitions + 1;
    end if;
  end loop;

  delete from public.instagram_observability_events_default where occurred_at < cutoff;
  get diagnostics deleted_default = row_count;
  delete from public.instagram_observability_rollups_5m where window_started_at < cutoff;
  get diagnostics deleted_rollups = row_count;
  delete from public.instagram_worker_rollups_5m where window_started_at < cutoff;
  get diagnostics deleted_worker_rollups = row_count;
  delete from public.instagram_observability_incident_actions where created_at < cutoff;
  get diagnostics deleted_actions = row_count;
  delete from public.instagram_observability_incidents
  where treatment_state = 'resolved' and greatest(last_seen_at, coalesce(resolved_at, last_seen_at)) < cutoff;
  get diagnostics deleted_resolved = row_count;

  if p_apply_legacy then
    delete from public.publication_item_events where created_at < cutoff;
    get diagnostics legacy_publication_events = row_count;
    delete from public.publication_worker_cycle_events where created_at < cutoff;
    get diagnostics legacy_cycle_events = row_count;
    delete from public.zernio_sync_log_items where created_at < cutoff;
    get diagnostics legacy_sync_logs = row_count;
    delete from public.zernio_publication_request_anomalies where occurred_at < cutoff;
    get diagnostics legacy_anomalies = row_count;
    delete from public.zernio_publication_request_rollups where window_started_at < cutoff;
    get diagnostics legacy_request_rollups = row_count;
  end if;

  return jsonb_build_object(
    'cutoff', cutoff,
    'droppedPartitions', dropped_partitions,
    'deletedDefaultEvents', deleted_default,
    'deletedResolvedIncidents', deleted_resolved,
    'deletedActions', deleted_actions,
    'deletedRollups', deleted_rollups,
    'deletedWorkerRollups', deleted_worker_rollups,
    'legacyApplied', p_apply_legacy,
    'legacy', jsonb_build_object(
      'publicationEvents', legacy_publication_events,
      'workerCycles', legacy_cycle_events,
      'syncLogs', legacy_sync_logs,
      'requestAnomalies', legacy_anomalies,
      'requestRollups', legacy_request_rollups
    )
  );
end;
$$;

alter table public.instagram_observability_incidents enable row level security;
alter table public.instagram_observability_events enable row level security;
alter table public.instagram_observability_incident_profiles enable row level security;
alter table public.instagram_observability_incident_entities enable row level security;
alter table public.instagram_observability_incident_actions enable row level security;
alter table public.instagram_observability_view_preferences enable row level security;
alter table public.instagram_observability_rollups_5m enable row level security;
alter table public.instagram_worker_rollups_5m enable row level security;

create policy instagram_observability_incidents_select_member
  on public.instagram_observability_incidents for select to authenticated
  using (public.is_organization_member(organization_id));
create policy instagram_observability_events_select_member
  on public.instagram_observability_events for select to authenticated
  using (public.is_organization_member(organization_id));
create policy instagram_observability_incident_profiles_select_member
  on public.instagram_observability_incident_profiles for select to authenticated
  using (exists (
    select 1 from public.instagram_observability_incidents incident
    where incident.id = incident_id and public.is_organization_member(incident.organization_id)
  ));
create policy instagram_observability_incident_entities_select_member
  on public.instagram_observability_incident_entities for select to authenticated
  using (exists (
    select 1 from public.instagram_observability_incidents incident
    where incident.id = incident_id and public.is_organization_member(incident.organization_id)
  ));
create policy instagram_observability_incident_actions_select_member
  on public.instagram_observability_incident_actions for select to authenticated
  using (public.is_organization_member(organization_id));
create policy instagram_observability_preferences_select_own
  on public.instagram_observability_view_preferences for select to authenticated
  using (actor_user_id = auth.uid() and public.is_organization_member(organization_id));
create policy instagram_observability_rollups_select_member
  on public.instagram_observability_rollups_5m for select to authenticated
  using (public.is_organization_member(organization_id));
create policy instagram_worker_rollups_superuser_select
  on public.instagram_worker_rollups_5m for select to authenticated
  using (public.is_system_super_user());

revoke all on public.instagram_observability_incidents,
  public.instagram_observability_events,
  public.instagram_observability_incident_profiles,
  public.instagram_observability_incident_entities,
  public.instagram_observability_incident_actions,
  public.instagram_observability_view_preferences,
  public.instagram_observability_rollups_5m,
  public.instagram_worker_rollups_5m from public, anon, authenticated;

grant select on public.instagram_observability_incidents,
  public.instagram_observability_events,
  public.instagram_observability_incident_profiles,
  public.instagram_observability_incident_entities,
  public.instagram_observability_incident_actions,
  public.instagram_observability_view_preferences,
  public.instagram_observability_rollups_5m to authenticated;
grant select on public.instagram_worker_rollups_5m to authenticated;

grant all on public.instagram_observability_incidents,
  public.instagram_observability_events,
  public.instagram_observability_incident_profiles,
  public.instagram_observability_incident_entities,
  public.instagram_observability_incident_actions,
  public.instagram_observability_view_preferences,
  public.instagram_observability_rollups_5m,
  public.instagram_worker_rollups_5m to service_role;

revoke all on function public.instagram_record_observability_event(
  uuid, public.instagram_observability_domain, public.instagram_observability_severity,
  public.instagram_observability_treatment, text, text, text, text, text, text,
  timestamptz, text, text, text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text,
  text, text, integer, text, text, text, text, jsonb, jsonb, text
) from public, anon, authenticated;
grant execute on function public.instagram_record_observability_event(
  uuid, public.instagram_observability_domain, public.instagram_observability_severity,
  public.instagram_observability_treatment, text, text, text, text, text, text,
  timestamptz, text, text, text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text,
  text, text, integer, text, text, text, text, jsonb, jsonb, text
) to service_role;
revoke all on function public.instagram_resolve_observability_entity(uuid, text, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.instagram_resolve_observability_entity(uuid, text, uuid, timestamptz) to service_role;
revoke all on function public.instagram_set_observability_incident_status(uuid, public.instagram_observability_treatment, text, text) from public, anon;
grant execute on function public.instagram_set_observability_incident_status(uuid, public.instagram_observability_treatment, text, text) to authenticated, service_role;
revoke all on function public.instagram_set_observability_view_preference(uuid, text, text) from public, anon;
grant execute on function public.instagram_set_observability_view_preference(uuid, text, text) to authenticated, service_role;
revoke all on function public.get_instagram_observability_summary(uuid) from public, anon;
grant execute on function public.get_instagram_observability_summary(uuid) to authenticated, service_role;
revoke all on function public.maintain_instagram_observability(integer, integer, boolean) from public, anon, authenticated;
grant execute on function public.maintain_instagram_observability(integer, integer, boolean) to service_role;

notify pgrst, 'reload schema';
