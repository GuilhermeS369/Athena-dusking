-- Centro de observabilidade do X/Twitter.
-- Camada aditiva: as tabelas financeiras e operacionais existentes continuam autoritativas.

create type public.twitter_observability_domain as enum (
  'account', 'scheduling', 'publication', 'worker', 'connection', 'analytics', 'finance'
);

create type public.twitter_observability_severity as enum (
  'info', 'warning', 'error', 'critical'
);

create type public.twitter_incident_status as enum (
  'open', 'investigating', 'resolved'
);

create table public.twitter_observability_incidents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  fingerprint text not null check (char_length(fingerprint) = 64),
  fingerprint_version integer not null default 1,
  domain public.twitter_observability_domain not null,
  stage text not null,
  stable_code text not null,
  worker_name text,
  severity public.twitter_observability_severity not null,
  status public.twitter_incident_status not null default 'open',
  title text not null,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  occurrence_count bigint not null default 0 check (occurrence_count >= 0),
  affected_profile_count integer not null default 0 check (affected_profile_count >= 0),
  reopen_count integer not null default 0 check (reopen_count >= 0),
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

create table public.twitter_observability_events (
  id uuid not null default gen_random_uuid(),
  occurred_at timestamptz not null default timezone('utc', now()),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  incident_id uuid references public.twitter_observability_incidents(id) on delete restrict,
  domain public.twitter_observability_domain not null,
  severity public.twitter_observability_severity not null default 'info',
  stage text not null check (char_length(trim(stage)) between 1 and 120),
  event_type text not null check (char_length(trim(event_type)) between 1 and 160),
  stable_code text not null check (char_length(trim(stable_code)) between 1 and 160),
  fingerprint text check (fingerprint is null or char_length(fingerprint) = 64),
  profile_id uuid references public.twitter_profiles(id) on delete restrict,
  connection_id uuid references public.twitter_connections(id) on delete restrict,
  program_id uuid references public.twitter_programs(id) on delete restrict,
  item_id uuid references public.twitter_publication_items(id) on delete restrict,
  analytics_item_id uuid references public.twitter_analytics_items(id) on delete restrict,
  attempt_id uuid,
  job_id uuid,
  worker_name text,
  worker_id text,
  http_status integer,
  provider_code text,
  request_id text,
  post_id text,
  correlation_id text,
  source_type text not null,
  source_id text not null,
  message text not null,
  evidence jsonb not null default '{}'::jsonb,
  primary key (occurred_at, id),
  check (jsonb_typeof(evidence) = 'object')
) partition by range (occurred_at);

create table public.twitter_observability_events_2026_05 partition of public.twitter_observability_events
  for values from ('2026-05-01 00:00:00+00') to ('2026-06-01 00:00:00+00');
create table public.twitter_observability_events_2026_06 partition of public.twitter_observability_events
  for values from ('2026-06-01 00:00:00+00') to ('2026-07-01 00:00:00+00');
create table public.twitter_observability_events_2026_07 partition of public.twitter_observability_events
  for values from ('2026-07-01 00:00:00+00') to ('2026-08-01 00:00:00+00');
create table public.twitter_observability_events_2026_08 partition of public.twitter_observability_events
  for values from ('2026-08-01 00:00:00+00') to ('2026-09-01 00:00:00+00');
create table public.twitter_observability_events_2026_09 partition of public.twitter_observability_events
  for values from ('2026-09-01 00:00:00+00') to ('2026-10-01 00:00:00+00');
create table public.twitter_observability_events_default partition of public.twitter_observability_events default;

create table public.twitter_observability_incident_profiles (
  incident_id uuid not null references public.twitter_observability_incidents(id) on delete cascade,
  profile_id uuid not null references public.twitter_profiles(id) on delete restrict,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  occurrence_count bigint not null default 1 check (occurrence_count > 0),
  primary key (incident_id, profile_id)
);

create table public.twitter_observability_incident_entities (
  incident_id uuid not null references public.twitter_observability_incidents(id) on delete cascade,
  entity_type text not null check (entity_type in ('connection', 'program')),
  entity_id uuid not null,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  occurrence_count bigint not null default 1 check (occurrence_count > 0),
  primary key (incident_id, entity_type, entity_id)
);

create table public.twitter_observability_incident_actions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  incident_id uuid not null references public.twitter_observability_incidents(id) on delete restrict,
  previous_status public.twitter_incident_status not null,
  status public.twitter_incident_status not null,
  justification text not null,
  fix_reference text,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_email text,
  created_at timestamptz not null default timezone('utc', now())
);

create table public.twitter_observability_view_preferences (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  actor_user_id uuid not null references auth.users(id) on delete cascade,
  scope_key text not null check (scope_key in (
    'account', 'scheduling', 'publication', 'worker', 'connection', 'analytics_finance', 'activity'
  )),
  cleared_at timestamptz,
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, actor_user_id, scope_key)
);

create table public.twitter_observability_archives (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  period_start timestamptz not null,
  period_end timestamptz not null,
  storage_path text not null unique,
  sha256 text not null check (char_length(sha256) = 64),
  row_count bigint not null check (row_count >= 0),
  byte_count bigint not null check (byte_count >= 0),
  status text not null default 'verified' check (status in ('verified', 'purged', 'failed')),
  verified_at timestamptz not null default timezone('utc', now()),
  purged_at timestamptz,
  error_message text,
  created_at timestamptz not null default timezone('utc', now()),
  check (period_end > period_start)
);

create index twitter_observability_incidents_queue_idx
  on public.twitter_observability_incidents (organization_id, status, severity, last_seen_at desc, id desc);
create index twitter_observability_incidents_domain_idx
  on public.twitter_observability_incidents (organization_id, domain, last_seen_at desc, id desc);
create index twitter_observability_events_org_time_idx
  on public.twitter_observability_events (organization_id, occurred_at desc, id desc);
create index twitter_observability_events_domain_time_idx
  on public.twitter_observability_events (organization_id, domain, occurred_at desc, id desc);
create index twitter_observability_events_profile_time_idx
  on public.twitter_observability_events (organization_id, profile_id, occurred_at desc, id desc)
  where profile_id is not null;
create index twitter_observability_events_incident_time_idx
  on public.twitter_observability_events (incident_id, occurred_at desc, id desc)
  where incident_id is not null;
create index twitter_observability_events_code_time_idx
  on public.twitter_observability_events (organization_id, stable_code, occurred_at desc, id desc);
create unique index twitter_observability_events_source_idx
  on public.twitter_observability_events (occurred_at, source_type, source_id);

create trigger twitter_observability_incidents_updated
before update on public.twitter_observability_incidents
for each row execute function public.set_updated_at();

create or replace function public.twitter_observability_severity_rank(p_value public.twitter_observability_severity)
returns integer language sql immutable parallel safe as $$
  select case p_value when 'critical' then 4 when 'error' then 3 when 'warning' then 2 else 1 end;
$$;

create or replace function public.twitter_observability_fingerprint(
  p_domain public.twitter_observability_domain,
  p_stage text,
  p_stable_code text,
  p_http_status integer default null,
  p_provider_code text default null,
  p_worker_name text default null
) returns text
language sql immutable parallel safe
as $$
  select encode(extensions.digest(concat_ws('|',
    'v1', p_domain::text, lower(trim(coalesce(p_stage, 'unknown'))),
    lower(trim(coalesce(p_stable_code, 'unknown'))),
    case when p_http_status is null then 'none' else (p_http_status / 100)::text || 'xx' end,
    lower(trim(coalesce(p_provider_code, 'none'))),
    lower(trim(coalesce(p_worker_name, 'none')))
  ), 'sha256'), 'hex');
$$;

create or replace function public.twitter_observability_sanitize_evidence(p_value jsonb)
returns jsonb
language plpgsql immutable parallel safe
as $$
declare result jsonb; entry record;
begin
  if p_value is null then return '{}'::jsonb; end if;
  if jsonb_typeof(p_value) = 'array' then
    select coalesce(jsonb_agg(public.twitter_observability_sanitize_evidence(value)), '[]'::jsonb)
    into result from jsonb_array_elements(p_value);
    return result;
  end if;
  if jsonb_typeof(p_value) <> 'object' then return p_value; end if;
  result := '{}'::jsonb;
  for entry in select key, value from jsonb_each(p_value) loop
    if lower(entry.key) ~ '(token|secret|authorization|api.?key|signed.?url|content|caption|body|media|password|cookie)' then
      continue;
    end if;
    if jsonb_typeof(entry.value) = 'string' and trim(both '"' from entry.value::text) ~* '^https?://' then
      result := result || jsonb_build_object(entry.key, '[url removida]');
    else
      result := result || jsonb_build_object(entry.key, public.twitter_observability_sanitize_evidence(entry.value));
    end if;
  end loop;
  return result;
end;
$$;

create or replace function public.twitter_observability_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  resolved_fingerprint text;
  incident_row public.twitter_observability_incidents;
  inserted_profile integer := 0;
begin
  new.stage := left(lower(trim(new.stage)), 120);
  new.event_type := left(lower(trim(new.event_type)), 160);
  new.stable_code := left(lower(trim(new.stable_code)), 160);
  new.message := left(regexp_replace(
    regexp_replace(trim(new.message), 'https?://[^[:space:]]+', '[url removida]', 'gi'),
    'bearer[[:space:]]+[a-z0-9._~+/-]+=*', 'Bearer [removido]', 'gi'
  ), 1000);
  new.provider_code := nullif(left(lower(trim(coalesce(new.provider_code, ''))), 160), '');
  new.worker_name := nullif(left(trim(coalesce(new.worker_name, '')), 180), '');
  new.worker_id := nullif(left(trim(coalesce(new.worker_id, '')), 240), '');
  new.request_id := nullif(left(trim(coalesce(new.request_id, '')), 300), '');
  new.post_id := nullif(left(trim(coalesce(new.post_id, '')), 300), '');
  new.correlation_id := nullif(left(trim(coalesce(new.correlation_id, '')), 300), '');
  new.source_type := left(lower(trim(new.source_type)), 120);
  new.source_id := left(trim(new.source_id), 300);
  new.evidence := public.twitter_observability_sanitize_evidence(new.evidence);

  if new.severity = 'info' then
    new.fingerprint := null;
    new.incident_id := null;
    return new;
  end if;

  resolved_fingerprint := coalesce(new.fingerprint, public.twitter_observability_fingerprint(
    new.domain, new.stage, new.stable_code, new.http_status, new.provider_code, new.worker_name
  ));
  new.fingerprint := resolved_fingerprint;

  insert into public.twitter_observability_incidents (
    organization_id, fingerprint, domain, stage, stable_code, worker_name,
    severity, status, title, first_seen_at, last_seen_at, occurrence_count
  ) values (
    new.organization_id, resolved_fingerprint, new.domain, new.stage, new.stable_code,
    new.worker_name, new.severity, 'open', new.message, new.occurred_at, new.occurred_at, 1
  )
  on conflict (organization_id, fingerprint) do update set
    severity = case
      when public.twitter_observability_severity_rank(excluded.severity) > public.twitter_observability_severity_rank(public.twitter_observability_incidents.severity)
        then excluded.severity else public.twitter_observability_incidents.severity end,
    status = case when public.twitter_observability_incidents.status = 'resolved' then 'open'::public.twitter_incident_status else public.twitter_observability_incidents.status end,
    reopen_count = public.twitter_observability_incidents.reopen_count + case when public.twitter_observability_incidents.status = 'resolved' then 1 else 0 end,
    last_seen_at = greatest(public.twitter_observability_incidents.last_seen_at, excluded.last_seen_at),
    occurrence_count = public.twitter_observability_incidents.occurrence_count + 1,
    title = excluded.title,
    resolved_at = case when public.twitter_observability_incidents.status = 'resolved' then null else public.twitter_observability_incidents.resolved_at end,
    resolved_by = case when public.twitter_observability_incidents.status = 'resolved' then null else public.twitter_observability_incidents.resolved_by end,
    resolution_justification = case when public.twitter_observability_incidents.status = 'resolved' then null else public.twitter_observability_incidents.resolution_justification end,
    fix_reference = case when public.twitter_observability_incidents.status = 'resolved' then null else public.twitter_observability_incidents.fix_reference end
  returning * into incident_row;

  new.incident_id := incident_row.id;
  if new.profile_id is not null then
    insert into public.twitter_observability_incident_profiles (
      incident_id, profile_id, first_seen_at, last_seen_at, occurrence_count
    ) values (incident_row.id, new.profile_id, new.occurred_at, new.occurred_at, 1)
    on conflict (incident_id, profile_id) do update set
      last_seen_at = greatest(public.twitter_observability_incident_profiles.last_seen_at, excluded.last_seen_at),
      occurrence_count = public.twitter_observability_incident_profiles.occurrence_count + 1;
    get diagnostics inserted_profile = row_count;

    -- row_count também é 1 em update; recalc mantém o contador correto e barato por incidente.
    update public.twitter_observability_incidents incident
    set affected_profile_count = (
      select count(*)::integer from public.twitter_observability_incident_profiles profile
      where profile.incident_id = incident_row.id
    ) where incident.id = incident_row.id;
  end if;
  if new.connection_id is not null then
    insert into public.twitter_observability_incident_entities (incident_id, entity_type, entity_id, first_seen_at, last_seen_at)
    values (incident_row.id, 'connection', new.connection_id, new.occurred_at, new.occurred_at)
    on conflict (incident_id, entity_type, entity_id) do update set
      last_seen_at = greatest(public.twitter_observability_incident_entities.last_seen_at, excluded.last_seen_at),
      occurrence_count = public.twitter_observability_incident_entities.occurrence_count + 1;
  end if;
  if new.program_id is not null then
    insert into public.twitter_observability_incident_entities (incident_id, entity_type, entity_id, first_seen_at, last_seen_at)
    values (incident_row.id, 'program', new.program_id, new.occurred_at, new.occurred_at)
    on conflict (incident_id, entity_type, entity_id) do update set
      last_seen_at = greatest(public.twitter_observability_incident_entities.last_seen_at, excluded.last_seen_at),
      occurrence_count = public.twitter_observability_incident_entities.occurrence_count + 1;
  end if;
  return new;
end;
$$;

create trigger twitter_observability_events_prepare
before insert on public.twitter_observability_events
for each row execute function public.twitter_observability_before_insert();

create or replace function public.twitter_mirror_operation_log_to_observability()
returns trigger language plpgsql security definer set search_path = public as $$
declare resolved_program_id uuid;
begin
  select item.program_id into resolved_program_id from public.twitter_publication_items item where item.id = new.item_id;
  insert into public.twitter_observability_events (
    occurred_at, organization_id, domain, severity, stage, event_type, stable_code,
    profile_id, connection_id, program_id, item_id, attempt_id, http_status, provider_code,
    request_id, post_id, source_type, source_id, message, evidence
  ) values (
    new.created_at, new.organization_id, 'publication',
    case new.phase when 'outcome_unknown' then 'critical'::public.twitter_observability_severity
      when 'confirmed_failure' then 'error'::public.twitter_observability_severity
      when 'rate_limited' then 'warning'::public.twitter_observability_severity
      when 'retry' then 'warning'::public.twitter_observability_severity else 'info'::public.twitter_observability_severity end,
    'publication', new.phase, coalesce(nullif(new.provider_code, ''), new.phase),
    new.profile_id, new.connection_id, resolved_program_id, new.item_id, new.attempt_id,
    new.http_status, new.provider_code, new.request_id, new.post_id,
    'twitter_operation_log', new.id::text, coalesce(nullif(new.message, ''), 'Evento de publicação X.'),
    coalesce(new.metadata, '{}') - 'content' - 'caption' - 'token' - 'authorization' - 'apiKey'
  ) on conflict (occurred_at, source_type, source_id) do nothing;
  return new;
exception when others then
  raise warning 'Falha ao espelhar operation log X %: %', new.id, sqlerrm;
  return new;
end;
$$;
create trigger twitter_operation_logs_observability
after insert on public.twitter_operation_logs
for each row execute function public.twitter_mirror_operation_log_to_observability();

create or replace function public.twitter_mirror_connection_event_to_observability()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.twitter_observability_events (
    occurred_at, organization_id, domain, severity, stage, event_type, stable_code,
    profile_id, connection_id, source_type, source_id, message, evidence
  ) values (
    new.created_at, new.organization_id, 'connection',
    case when new.event_type in ('sync_failed') then 'error'::public.twitter_observability_severity else 'info'::public.twitter_observability_severity end,
    'zernio_connection', new.event_type, coalesce(new.metadata->>'errorCode', new.event_type),
    new.profile_id, new.connection_id, 'twitter_connection_event', new.id::text,
    coalesce(nullif(new.message, ''), 'Evento de conexão X.'),
    coalesce(new.metadata, '{}') - 'token' - 'authorization' - 'apiKey'
  ) on conflict (occurred_at, source_type, source_id) do nothing;
  return new;
exception when others then
  raise warning 'Falha ao espelhar connection event X %: %', new.id, sqlerrm;
  return new;
end;
$$;
create trigger twitter_connection_events_observability
after insert on public.twitter_connection_events
for each row execute function public.twitter_mirror_connection_event_to_observability();

create or replace function public.prevent_twitter_observability_event_mutation()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and current_setting('app.twitter_observability_archive_purge', true) = 'on' then
    return old;
  end if;
  raise exception using errcode = '55000', message = 'Eventos de observabilidade X são imutáveis.';
end;
$$;

create trigger twitter_observability_events_immutable
before update or delete on public.twitter_observability_events
for each row execute function public.prevent_twitter_observability_event_mutation();

create trigger twitter_observability_actions_immutable
before update or delete on public.twitter_observability_incident_actions
for each row execute function public.prevent_twitter_immutable_mutation();

create or replace function public.twitter_record_observability_event(
  p_organization_id uuid,
  p_domain public.twitter_observability_domain,
  p_severity public.twitter_observability_severity,
  p_stage text,
  p_event_type text,
  p_stable_code text,
  p_message text,
  p_source_type text,
  p_source_id text,
  p_occurred_at timestamptz default timezone('utc', now()),
  p_profile_id uuid default null,
  p_connection_id uuid default null,
  p_program_id uuid default null,
  p_item_id uuid default null,
  p_analytics_item_id uuid default null,
  p_attempt_id uuid default null,
  p_job_id uuid default null,
  p_worker_name text default null,
  p_worker_id text default null,
  p_http_status integer default null,
  p_provider_code text default null,
  p_request_id text default null,
  p_post_id text default null,
  p_correlation_id text default null,
  p_evidence jsonb default '{}'
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare inserted public.twitter_observability_events;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Apenas service_role registra eventos X.';
  end if;
  insert into public.twitter_observability_events (
    occurred_at, organization_id, domain, severity, stage, event_type, stable_code,
    profile_id, connection_id, program_id, item_id, analytics_item_id, attempt_id, job_id,
    worker_name, worker_id, http_status, provider_code, request_id, post_id,
    correlation_id, source_type, source_id, message, evidence
  ) values (
    coalesce(p_occurred_at, timezone('utc', now())), p_organization_id, p_domain, p_severity,
    p_stage, p_event_type, p_stable_code, p_profile_id, p_connection_id, p_program_id,
    p_item_id, p_analytics_item_id, p_attempt_id, p_job_id, p_worker_name, p_worker_id, p_http_status,
    p_provider_code, p_request_id, p_post_id, p_correlation_id, p_source_type,
    p_source_id, p_message, coalesce(p_evidence, '{}')
  ) returning * into inserted;
  return jsonb_build_object('eventId', inserted.id, 'incidentId', inserted.incident_id, 'occurredAt', inserted.occurred_at);
end;
$$;

create or replace function public.twitter_set_observability_incident_status(
  p_incident_id uuid,
  p_status public.twitter_incident_status,
  p_justification text,
  p_fix_reference text default null
) returns public.twitter_observability_incidents
language plpgsql security definer set search_path = public
as $$
declare incident public.twitter_observability_incidents;
declare previous public.twitter_incident_status;
declare actor_email text;
begin
  select * into incident from public.twitter_observability_incidents where id = p_incident_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Incidente X não encontrado.'; end if;
  if not public.has_organization_role(incident.organization_id, array['admin','operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Permissão insuficiente.';
  end if;
  if char_length(trim(coalesce(p_justification, ''))) < 8 then
    raise exception using errcode = '22023', message = 'Justificativa deve ter ao menos 8 caracteres.';
  end if;
  previous := incident.status;
  select email into actor_email from auth.users where id = auth.uid();
  update public.twitter_observability_incidents set
    status = p_status,
    investigating_at = case when p_status = 'investigating' then timezone('utc', now()) else investigating_at end,
    investigating_by = case when p_status = 'investigating' then auth.uid() else investigating_by end,
    resolved_at = case when p_status = 'resolved' then timezone('utc', now()) else null end,
    resolved_by = case when p_status = 'resolved' then auth.uid() else null end,
    resolution_justification = case when p_status = 'resolved' then trim(p_justification) else null end,
    fix_reference = case when p_status = 'resolved' then nullif(trim(coalesce(p_fix_reference, '')), '') else null end
  where id = incident.id returning * into incident;
  insert into public.twitter_observability_incident_actions (
    organization_id, incident_id, previous_status, status, justification,
    fix_reference, actor_user_id, actor_email
  ) values (
    incident.organization_id, incident.id, previous, p_status, trim(p_justification),
    nullif(trim(coalesce(p_fix_reference, '')), ''), auth.uid(), actor_email
  );
  return incident;
end;
$$;

create or replace function public.twitter_set_observability_view_preference(
  p_organization_id uuid,
  p_scope_key text,
  p_action text
) returns public.twitter_observability_view_preferences
language plpgsql security definer set search_path = public
as $$
declare preference public.twitter_observability_view_preferences;
begin
  if not public.is_organization_member(p_organization_id) then
    raise exception using errcode = '42501', message = 'Permissão insuficiente.';
  end if;
  if p_scope_key not in ('account','scheduling','publication','worker','connection','analytics_finance','activity')
    or p_action not in ('clear','undo') then
    raise exception using errcode = '22023', message = 'Preferência de logs X inválida.';
  end if;
  insert into public.twitter_observability_view_preferences (
    organization_id, actor_user_id, scope_key, cleared_at
  ) values (
    p_organization_id, auth.uid(), p_scope_key,
    case when p_action = 'clear' then timezone('utc', now()) else null end
  ) on conflict (organization_id, actor_user_id, scope_key) do update set
    cleared_at = excluded.cleared_at,
    updated_at = timezone('utc', now())
  returning * into preference;
  return preference;
end;
$$;

create or replace function public.twitter_purge_archived_observability_events(p_archive_id uuid)
returns bigint language plpgsql security definer set search_path = public
as $$
declare archive public.twitter_observability_archives;
declare removed bigint;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Apenas service_role remove eventos arquivados.';
  end if;
  select * into archive from public.twitter_observability_archives where id = p_archive_id for update;
  if not found or archive.status <> 'verified' then
    raise exception using errcode = '55000', message = 'Arquivo X ainda não foi verificado.';
  end if;
  if archive.period_end > timezone('utc', now()) - interval '90 days' then
    raise exception using errcode = '55000', message = 'Período X ainda está na retenção quente.';
  end if;
  perform set_config('app.twitter_observability_archive_purge', 'on', true);
  delete from public.twitter_observability_events
  where organization_id = archive.organization_id
    and occurred_at >= archive.period_start and occurred_at < archive.period_end;
  get diagnostics removed = row_count;
  if removed <> archive.row_count then
    raise exception using errcode = '55000', message = 'Contagem do arquivo X diverge do banco.';
  end if;
  update public.twitter_observability_archives
  set status = 'purged', purged_at = timezone('utc', now()) where id = archive.id;
  return removed;
end;
$$;

create or replace function public.twitter_ensure_observability_partitions(p_months_ahead integer default 3)
returns text[] language plpgsql security definer set search_path = public
as $$
declare month_start date; partition_name text; created_names text[] := array[]::text[];
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception using errcode = '42501'; end if;
  for offset_value in 0..least(greatest(coalesce(p_months_ahead, 3), 1), 12) loop
    month_start := date_trunc('month', timezone('utc', now()))::date + (offset_value || ' months')::interval;
    partition_name := 'twitter_observability_events_' || to_char(month_start, 'YYYY_MM');
    if to_regclass('public.' || partition_name) is null then
      execute format('create table public.%I partition of public.twitter_observability_events for values from (%L) to (%L)', partition_name, month_start::timestamptz, (month_start + interval '1 month')::timestamptz);
      created_names := array_append(created_names, partition_name);
    end if;
  end loop;
  return created_names;
end;
$$;

-- Backfill idempotente da janela quente. Eventos futuros entram pela RPC acima.
insert into public.twitter_observability_events (
  occurred_at, organization_id, domain, severity, stage, event_type, stable_code,
  profile_id, connection_id, item_id, attempt_id, http_status, provider_code,
  request_id, post_id, source_type, source_id, message, evidence
)
select log.created_at, log.organization_id, 'publication',
  case log.phase
    when 'outcome_unknown' then 'critical'::public.twitter_observability_severity
    when 'confirmed_failure' then 'error'::public.twitter_observability_severity
    when 'rate_limited' then 'warning'::public.twitter_observability_severity
    when 'retry' then 'warning'::public.twitter_observability_severity
    else 'info'::public.twitter_observability_severity end,
  'publication', log.phase, coalesce(nullif(log.provider_code, ''), log.phase),
  log.profile_id, log.connection_id, log.item_id, log.attempt_id, log.http_status,
  log.provider_code, log.request_id, log.post_id, 'twitter_operation_log', log.id::text,
  coalesce(nullif(log.message, ''), 'Evento de publicação X.'), coalesce(log.metadata, '{}')
from public.twitter_operation_logs log
where log.created_at >= timezone('utc', now()) - interval '90 days'
on conflict (occurred_at, source_type, source_id) do nothing;

insert into public.twitter_observability_events (
  occurred_at, organization_id, domain, severity, stage, event_type, stable_code,
  analytics_item_id, attempt_id, http_status, provider_code, request_id,
  source_type, source_id, message, evidence
)
select attempt.started_at, attempt.organization_id, 'analytics',
  case attempt.status when 'outcome_unknown' then 'critical'::public.twitter_observability_severity
    when 'failed' then 'error'::public.twitter_observability_severity else 'info'::public.twitter_observability_severity end,
  'analytics_read', attempt.status::text, coalesce(nullif(attempt.provider_code, ''), attempt.status::text),
  attempt.item_id, attempt.id, attempt.http_status, attempt.provider_code, attempt.request_id,
  'twitter_analytics_attempt', attempt.id::text,
  coalesce(nullif(attempt.error_message, ''), 'Tentativa de analytics X.'), coalesce(attempt.evidence, '{}')
from public.twitter_analytics_attempts attempt
where attempt.started_at >= timezone('utc', now()) - interval '90 days'
on conflict (occurred_at, source_type, source_id) do nothing;

insert into public.twitter_observability_events (
  occurred_at, organization_id, domain, severity, stage, event_type, stable_code,
  profile_id, connection_id, source_type, source_id, message, evidence
)
select event.created_at, event.organization_id, 'connection',
  case when event.event_type in ('sync_failed') then 'error'::public.twitter_observability_severity else 'info'::public.twitter_observability_severity end,
  'zernio_connection', event.event_type, coalesce(event.metadata->>'errorCode', event.event_type),
  event.profile_id, event.connection_id, 'twitter_connection_event', event.id::text,
  coalesce(nullif(event.message, ''), 'Evento de conexão X.'), coalesce(event.metadata, '{}')
from public.twitter_connection_events event
where event.created_at >= timezone('utc', now()) - interval '90 days'
on conflict (occurred_at, source_type, source_id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('twitter-log-archives', 'twitter-log-archives', false, 52428800, array['application/gzip'])
on conflict (id) do update set public = false;

alter table public.twitter_observability_incidents enable row level security;
alter table public.twitter_observability_events enable row level security;
alter table public.twitter_observability_incident_profiles enable row level security;
alter table public.twitter_observability_incident_entities enable row level security;
alter table public.twitter_observability_incident_actions enable row level security;
alter table public.twitter_observability_view_preferences enable row level security;
alter table public.twitter_observability_archives enable row level security;

create policy twitter_observability_incidents_select on public.twitter_observability_incidents
for select to authenticated using (public.is_organization_member(organization_id));
create policy twitter_observability_events_select on public.twitter_observability_events
for select to authenticated using (public.is_organization_member(organization_id));
create policy twitter_observability_incident_profiles_select on public.twitter_observability_incident_profiles
for select to authenticated using (exists (
  select 1 from public.twitter_observability_incidents incident
  where incident.id = public.twitter_observability_incident_profiles.incident_id
    and public.is_organization_member(incident.organization_id)
));
create policy twitter_observability_incident_entities_select on public.twitter_observability_incident_entities
for select to authenticated using (exists (
  select 1 from public.twitter_observability_incidents incident
  where incident.id = public.twitter_observability_incident_entities.incident_id
    and public.is_organization_member(incident.organization_id)
));
create policy twitter_observability_actions_select on public.twitter_observability_incident_actions
for select to authenticated using (public.is_organization_member(organization_id));
create policy twitter_observability_preferences_select on public.twitter_observability_view_preferences
for select to authenticated using (actor_user_id = auth.uid() and public.is_organization_member(organization_id));
create policy twitter_observability_archives_admin_select on public.twitter_observability_archives
for select to authenticated using (
  public.has_organization_role(organization_id, array['admin']::public.organization_role[])
);

revoke all on public.twitter_observability_incidents, public.twitter_observability_events,
  public.twitter_observability_incident_profiles, public.twitter_observability_incident_actions,
  public.twitter_observability_incident_entities,
  public.twitter_observability_view_preferences, public.twitter_observability_archives
from public, anon, authenticated;
grant select on public.twitter_observability_incidents, public.twitter_observability_events,
  public.twitter_observability_incident_profiles, public.twitter_observability_incident_actions,
  public.twitter_observability_incident_entities,
  public.twitter_observability_view_preferences to authenticated;
grant select on public.twitter_observability_archives to authenticated;
grant all on public.twitter_observability_incidents, public.twitter_observability_events,
  public.twitter_observability_incident_profiles, public.twitter_observability_incident_actions,
  public.twitter_observability_incident_entities,
  public.twitter_observability_view_preferences, public.twitter_observability_archives to service_role;

revoke all on function public.twitter_record_observability_event(uuid,public.twitter_observability_domain,public.twitter_observability_severity,text,text,text,text,text,text,timestamptz,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,integer,text,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.twitter_record_observability_event(uuid,public.twitter_observability_domain,public.twitter_observability_severity,text,text,text,text,text,text,timestamptz,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,integer,text,text,text,text,jsonb) to service_role;
revoke all on function public.twitter_set_observability_incident_status(uuid,public.twitter_incident_status,text,text) from public, anon;
grant execute on function public.twitter_set_observability_incident_status(uuid,public.twitter_incident_status,text,text) to authenticated, service_role;
revoke all on function public.twitter_set_observability_view_preference(uuid,text,text) from public, anon;
grant execute on function public.twitter_set_observability_view_preference(uuid,text,text) to authenticated, service_role;
revoke all on function public.twitter_purge_archived_observability_events(uuid) from public, anon, authenticated;
grant execute on function public.twitter_purge_archived_observability_events(uuid) to service_role;
revoke all on function public.twitter_ensure_observability_partitions(integer) from public, anon, authenticated;
grant execute on function public.twitter_ensure_observability_partitions(integer) to service_role;

notify pgrst, 'reload schema';
