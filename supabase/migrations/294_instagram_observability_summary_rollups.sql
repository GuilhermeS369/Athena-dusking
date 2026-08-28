-- Remove o count da tabela particionada do caminho quente do resumo.
-- O rollup de cinco minutos mantém o cartão operacional barato mesmo com
-- milhões de eventos quentes.

create or replace function public.aggregate_instagram_observability_event_rollup()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  bucket timestamptz := date_trunc('hour', new.occurred_at)
    + make_interval(mins => (extract(minute from new.occurred_at)::integer / 5) * 5);
begin
  insert into public.instagram_observability_rollups_5m (
    organization_id, window_started_at, domain, provider, operation, outcome,
    event_count, duration_sum_ms, duration_min_ms, duration_max_ms
  ) values (
    new.organization_id, bucket, new.domain, coalesce(new.provider, 'none'),
    new.event_type, coalesce(new.source_status, new.treatment_state::text),
    1, 0, null, null
  ) on conflict (organization_id, window_started_at, domain, provider, operation, outcome)
  do update set
    event_count = public.instagram_observability_rollups_5m.event_count + 1,
    updated_at = timezone('utc', now());
  return new;
exception when others then
  raise warning 'instagram observability rollup failed: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists instagram_observability_events_aggregate_rollup
  on public.instagram_observability_events;
create trigger instagram_observability_events_aggregate_rollup
after insert on public.instagram_observability_events
for each row execute function public.aggregate_instagram_observability_event_rollup();

revoke all on function public.aggregate_instagram_observability_event_rollup()
  from public, anon, authenticated;
grant execute on function public.aggregate_instagram_observability_event_rollup()
  to service_role;

insert into public.instagram_observability_rollups_5m (
  organization_id, window_started_at, domain, provider, operation, outcome,
  event_count, duration_sum_ms, duration_min_ms, duration_max_ms
)
select event.organization_id,
  date_trunc('hour', event.occurred_at)
    + make_interval(mins => (extract(minute from event.occurred_at)::integer / 5) * 5),
  event.domain, coalesce(event.provider, 'none'), event.event_type,
  coalesce(event.source_status, event.treatment_state::text), count(*), 0, null, null
from public.instagram_observability_events event
where event.occurred_at >= timezone('utc', now()) - interval '14 days'
group by 1,2,3,4,5,6
on conflict (organization_id, window_started_at, domain, provider, operation, outcome)
do update set event_count = excluded.event_count, updated_at = timezone('utc', now());

create or replace function public.get_instagram_observability_summary(
  p_organization_id uuid
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare result jsonb;
begin
  if not public.is_organization_member(p_organization_id) then
    raise exception using errcode = '42501', message = 'Permissão insuficiente.';
  end if;
  with active_incidents as materialized (
    select * from public.instagram_observability_incidents
    where organization_id = p_organization_id and treatment_state <> 'resolved'
  ), worker_kinds as (
    select unnest(array['publication','publication_planner','media_deletion','profile_analytics','zernio_sync']) as worker_kind
  ), worker_latest as (
    select kind.worker_kind, max(heartbeat.last_seen_at) as last_seen_at,
      (array_agg(heartbeat.status order by heartbeat.last_seen_at desc)
        filter (where heartbeat.status is not null))[1] as status
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
      'affectedProfiles', (select count(distinct profile.profile_id)
        from public.instagram_observability_incident_profiles profile
        join active_incidents incident on incident.id = profile.incident_id),
      'byDomain', coalesce((select jsonb_object_agg(domain::text, total)
        from (select domain, count(*) total from active_incidents group by domain) domains), '{}'::jsonb)
    ),
    'events24h', coalesce((select sum(rollup.event_count)
      from public.instagram_observability_rollups_5m rollup
      where rollup.organization_id = p_organization_id
        and rollup.window_started_at >= date_trunc('hour', timezone('utc', now()) - interval '24 hours')
          + make_interval(mins => (extract(minute from timezone('utc', now()) - interval '24 hours')::integer / 5) * 5)), 0),
    'workers', jsonb_build_object(
      'expected', (select count(*) from worker_latest),
      'active', (select count(*) from worker_latest where last_seen_at >= timezone('utc', now()) - interval '120 seconds' and status not in ('stopped','error')),
      'stale', (select count(*) from worker_latest where last_seen_at is null or last_seen_at < timezone('utc', now()) - interval '120 seconds' or status in ('stopped','error'))
    ),
    'checkedAt', timezone('utc', now()), 'retentionDays', 14
  ) into result;
  return result;
end;
$$;

notify pgrst, 'reload schema';
