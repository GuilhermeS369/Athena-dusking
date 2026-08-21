-- Auditoria durável de ciclos do worker e slots coletivos atrasados.
-- Dados de infraestrutura permanecem exclusivos do service role/superusuário no servidor.

create table public.publication_worker_cycle_events (
  id uuid primary key default gen_random_uuid(),
  correlation_id uuid not null,
  worker_id text not null check (char_length(trim(worker_id)) between 3 and 120),
  worker_kind text not null default 'publication' check (worker_kind in ('publication')),
  phase text not null check (phase in ('started', 'completed', 'failed')),
  started_at timestamptz not null,
  completed_at timestamptz,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  metadata jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text,
  created_at timestamptz not null default timezone('utc', now()),
  check ((phase = 'started' and completed_at is null and duration_ms is null) or phase <> 'started'),
  check (char_length(coalesce(error_code, '')) <= 120),
  check (char_length(coalesce(error_message, '')) <= 1200)
);

create index publication_worker_cycle_events_worker_created_idx
  on public.publication_worker_cycle_events(worker_id, created_at desc);
create index publication_worker_cycle_events_correlation_idx
  on public.publication_worker_cycle_events(correlation_id, created_at);
create index publication_worker_cycle_events_phase_created_idx
  on public.publication_worker_cycle_events(phase, created_at desc);

create table public.publication_slot_risk_incidents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  batch_id uuid not null references public.publication_batches(id) on delete cascade,
  slot_execute_at timestamptz not null,
  state text not null default 'at_risk' check (state in ('at_risk', 'recovered', 'ignored')),
  affected_item_count integer not null default 0 check (affected_item_count >= 0),
  overdue_seconds integer not null default 0 check (overdue_seconds >= 0),
  next_slot_execute_at timestamptz,
  decision_reason text not null default 'awaiting_safe_recovery' check (char_length(trim(decision_reason)) between 1 and 160),
  last_worker_id text,
  last_cycle_correlation_id uuid,
  resolved_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (organization_id, batch_id, slot_execute_at),
  check ((state = 'at_risk' and resolved_at is null) or state <> 'at_risk')
);

create index publication_slot_risk_incidents_org_state_idx
  on public.publication_slot_risk_incidents(organization_id, state, slot_execute_at desc);
create index publication_slot_risk_incidents_state_created_idx
  on public.publication_slot_risk_incidents(state, created_at desc);

create trigger publication_slot_risk_incidents_set_updated_at
before update on public.publication_slot_risk_incidents
for each row execute function public.set_updated_at();

alter table public.publication_worker_cycle_events enable row level security;
alter table public.publication_slot_risk_incidents enable row level security;
revoke all on public.publication_worker_cycle_events, public.publication_slot_risk_incidents from public, anon, authenticated;
grant all on public.publication_worker_cycle_events, public.publication_slot_risk_incidents to service_role;

create or replace function public.record_publication_worker_cycle_event(
  p_correlation_id uuid,
  p_worker_id text,
  p_phase text,
  p_started_at timestamptz,
  p_completed_at timestamptz default null,
  p_metadata jsonb default '{}'::jsonb,
  p_error_code text default null,
  p_error_message text default null
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  event_id uuid;
  duration integer;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao worker.';
  end if;
  if p_phase not in ('started', 'completed', 'failed') then
    raise exception using errcode = '22023', message = 'Fase de ciclo inválida.';
  end if;
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 or p_started_at is null then
    raise exception using errcode = '22023', message = 'Dados de ciclo inválidos.';
  end if;
  if p_phase = 'started' then
    p_completed_at := null;
    duration := null;
  else
    p_completed_at := coalesce(p_completed_at, timezone('utc', now()));
    duration := greatest(0, extract(epoch from (p_completed_at - p_started_at)) * 1000)::integer;
  end if;
  insert into public.publication_worker_cycle_events (
    correlation_id, worker_id, phase, started_at, completed_at, duration_ms, metadata, error_code, error_message
  ) values (
    p_correlation_id, trim(p_worker_id), p_phase, p_started_at, p_completed_at, duration,
    coalesce(p_metadata, '{}'::jsonb), left(nullif(trim(p_error_code), ''), 120), left(nullif(trim(p_error_message), ''), 1200)
  ) returning id into event_id;
  return event_id;
end;
$$;

create or replace function public.recover_missed_publication_slots(
  p_max_items integer default 100,
  p_grace_seconds integer default 120,
  p_worker_id text default null,
  p_cycle_correlation_id uuid default null
)
returns table (
  id uuid,
  organization_id uuid,
  profile_id uuid,
  previous_execute_at timestamptz,
  execute_at timestamptz,
  outcome text
)
language plpgsql security definer set search_path = public as $$
declare
  item_row public.publication_items%rowtype;
  candidate_window_start timestamptz;
  candidate_minute timestamptz;
  recovered_at timestamptz := timezone('utc', now());
  next_slot_at timestamptz;
  risk_count integer;
begin
  if p_max_items not between 1 and 500 then raise exception using errcode = '22023', message = 'Limite de recuperação deve estar entre 1 e 500'; end if;
  if p_grace_seconds not between 30 and 3600 then raise exception using errcode = '22023', message = 'Margem de atraso deve estar entre 30 e 3600 segundos'; end if;

  for item_row in
    select item_source.* from public.publication_items item_source
    where item_source.status in ('waiting', 'ready') and item_source.execute_at is not null
      and item_source.execute_at <= recovered_at - make_interval(secs => p_grace_seconds)
      and (item_source.next_attempt_at is null or item_source.next_attempt_at <= recovered_at)
      and (item_source.lease_until is null or item_source.lease_until <= recovered_at)
      and item_source.creation_id is null
    order by item_source.execute_at, item_source.created_at, item_source.id
    for update skip locked limit p_max_items
  loop
    id := item_row.id; organization_id := item_row.organization_id; profile_id := item_row.profile_id; previous_execute_at := item_row.execute_at;

    if item_row.idempotency_key like 'bulk:%' then
      select min(other_item.execute_at) into next_slot_at
      from public.publication_items other_item
      where other_item.organization_id = item_row.organization_id and other_item.batch_id = item_row.batch_id
        and other_item.idempotency_key like 'bulk:%' and other_item.execute_at > item_row.execute_at
        and other_item.status in ('waiting', 'ready', 'preparing', 'publishing');
      select count(*)::integer into risk_count
      from public.publication_items risk_item
      where risk_item.organization_id = item_row.organization_id and risk_item.batch_id = item_row.batch_id
        and risk_item.execute_at = item_row.execute_at and risk_item.idempotency_key like 'bulk:%'
        and risk_item.status in ('waiting', 'ready');
      insert into public.publication_slot_risk_incidents (
        organization_id, batch_id, slot_execute_at, affected_item_count, overdue_seconds, next_slot_execute_at,
        decision_reason, last_worker_id, last_cycle_correlation_id
      ) values (
        item_row.organization_id, item_row.batch_id, item_row.execute_at, risk_count,
        greatest(0, extract(epoch from (recovered_at - item_row.execute_at))::integer), next_slot_at,
        'awaiting_safe_recovery', left(nullif(trim(p_worker_id), ''), 120), p_cycle_correlation_id
      ) on conflict (organization_id, batch_id, slot_execute_at) do update set
        affected_item_count = excluded.affected_item_count,
        overdue_seconds = excluded.overdue_seconds,
        next_slot_execute_at = excluded.next_slot_execute_at,
        last_worker_id = excluded.last_worker_id,
        last_cycle_correlation_id = excluded.last_cycle_correlation_id,
        decision_reason = case when public.publication_slot_risk_incidents.state = 'at_risk' then 'awaiting_safe_recovery' else public.publication_slot_risk_incidents.decision_reason end;
      execute_at := item_row.execute_at;
      outcome := 'bulk_slot_at_risk';
      return next;
      continue;
    end if;

    if item_row.missed_schedule_recovery_count >= 1 then
      update public.publication_items set status = 'failed', claimed_by = null, lease_until = null, next_attempt_at = null,
        last_error_code = 'missed_schedule_requires_attention', last_error_message = 'A publicação voltou a perder o horário após um reagendamento automático e precisa de intervenção manual.' where publication_items.id = item_row.id;
      perform public.log_publication_item_event(item_row.id, 'failed', item_row.status, 'failed', null, 'system: missed-schedule-recovery', 'missed_schedule_requires_attention', 'A publicação voltou a perder o horário após um reagendamento automático e precisa de intervenção manual.', jsonb_build_object('previous_execute_at', item_row.execute_at, 'recovery_count', item_row.missed_schedule_recovery_count));
      perform public.sync_publication_batch_status(item_row.batch_id);
      outcome := 'requires_attention'; return next; continue;
    end if;

    candidate_window_start := (((item_row.execute_at at time zone 'America/Sao_Paulo')::date + 1) + date_trunc('hour', item_row.execute_at at time zone 'America/Sao_Paulo')::time + make_interval(mins => (extract(minute from item_row.execute_at at time zone 'America/Sao_Paulo')::integer / 10) * 10)) at time zone 'America/Sao_Paulo';
    loop
      exit when candidate_window_start > recovered_at and not exists (
        select 1 from public.publication_items occupied where occupied.organization_id = item_row.organization_id and occupied.profile_id = item_row.profile_id and occupied.execute_at >= candidate_window_start and occupied.execute_at < candidate_window_start + interval '10 minutes' and occupied.status in ('waiting', 'ready', 'preparing', 'publishing')
      );
      candidate_window_start := candidate_window_start + interval '1 day';
    end loop;
    perform pg_advisory_xact_lock(hashtextextended(item_row.profile_id::text, 0));
    loop
      candidate_minute := null;
      select candidate.minute_start into candidate_minute from (select candidate_window_start + make_interval(mins => minute_offset) as minute_start from generate_series(1, 9) minute_offset) candidate
      where not exists (select 1 from public.publication_items occupied where occupied.organization_id = item_row.organization_id and occupied.profile_id = item_row.profile_id and date_trunc('minute', occupied.execute_at) = candidate.minute_start and occupied.status in ('waiting', 'ready', 'preparing', 'publishing')) order by random() limit 1;
      exit when candidate_minute is not null;
      candidate_window_start := candidate_window_start + interval '1 day';
    end loop;
    update public.publication_items set execute_at = candidate_minute + make_interval(secs => floor(random() * 60)::integer), status = 'waiting', claimed_by = null, lease_until = null, next_attempt_at = null, missed_schedule_recovery_count = 1, last_error_code = 'missed_schedule_recovered', last_error_message = 'O worker não iniciou a publicação no horário previsto; ela foi reagendada automaticamente uma única vez.' where publication_items.id = item_row.id returning publication_items.execute_at into execute_at;
    perform public.log_publication_item_event(item_row.id, 'processing_deferred', item_row.status, 'waiting', null, 'system: missed-schedule-recovery', 'missed_schedule_recovered', 'O worker não iniciou a publicação no horário previsto; ela foi reagendada automaticamente uma única vez.', jsonb_build_object('previous_execute_at', item_row.execute_at, 'rescheduled_execute_at', execute_at, 'recovery_count', 1));
    perform public.sync_publication_batch_status(item_row.batch_id);
    outcome := 'rescheduled_once'; return next;
  end loop;
end;
$$;

revoke all on function public.record_publication_worker_cycle_event(uuid, text, text, timestamptz, timestamptz, jsonb, text, text) from public, anon, authenticated;
revoke all on function public.recover_missed_publication_slots(integer, integer, text, uuid) from public, anon, authenticated;
grant execute on function public.record_publication_worker_cycle_event(uuid, text, text, timestamptz, timestamptz, jsonb, text, text) to service_role;
grant execute on function public.recover_missed_publication_slots(integer, integer, text, uuid) to service_role;
