-- Mantém a leitura do cabeçalho da Central de Logs constante mesmo quando o
-- volume de incidentes e perfis cresce. A recomposição pesada acontece uma vez
-- por ciclo de manutenção e a API lê apenas uma linha por organização.

create table if not exists public.instagram_observability_summary_snapshots (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  incidents jsonb not null default '{}'::jsonb
    check (jsonb_typeof(incidents) = 'object'),
  events_24h bigint not null default 0 check (events_24h >= 0),
  refreshed_at timestamptz not null default timezone('utc', now())
);

alter table public.instagram_observability_summary_snapshots enable row level security;
revoke all on public.instagram_observability_summary_snapshots from public, anon, authenticated;
grant all on public.instagram_observability_summary_snapshots to service_role;

create or replace function public.refresh_instagram_observability_summary_snapshots(
  p_organization_id uuid default null
) returns integer
language plpgsql security definer set search_path = public as $$
declare refreshed_count integer;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Somente service_role pode recompor resumos.';
  end if;

  insert into public.instagram_observability_summary_snapshots (
    organization_id, incidents, events_24h, refreshed_at
  )
  select organization.id,
    jsonb_build_object(
      'actionRequired', count(*) filter (where incident.treatment_state = 'action_required'),
      'investigating', count(*) filter (where incident.treatment_state = 'investigating'),
      'autoRecovering', count(*) filter (where incident.treatment_state = 'auto_recovering'),
      'contained', count(*) filter (where incident.treatment_state = 'contained'),
      'critical', count(*) filter (where incident.severity = 'critical'),
      'affectedProfiles', coalesce(profile_total.total, 0),
      'byDomain', coalesce(domain_total.value, '{}'::jsonb)
    ),
    coalesce(event_total.total, 0),
    timezone('utc', now())
  from public.organizations organization
  left join public.instagram_observability_incidents incident
    on incident.organization_id = organization.id
   and incident.treatment_state <> 'resolved'
  left join lateral (
    select count(distinct profile.profile_id)::bigint as total
    from public.instagram_observability_incident_profiles profile
    join public.instagram_observability_incidents active
      on active.id = profile.incident_id
     and active.organization_id = organization.id
     and active.treatment_state <> 'resolved'
  ) profile_total on true
  left join lateral (
    select jsonb_object_agg(grouped.domain::text, grouped.total) as value
    from (
      select active.domain, count(*)::bigint as total
      from public.instagram_observability_incidents active
      where active.organization_id = organization.id
        and active.treatment_state <> 'resolved'
      group by active.domain
    ) grouped
  ) domain_total on true
  left join lateral (
    select coalesce(sum(rollup.event_count), 0)::bigint as total
    from public.instagram_observability_rollups_5m rollup
    where rollup.organization_id = organization.id
      and rollup.window_started_at >= date_trunc('hour', timezone('utc', now()) - interval '24 hours')
        + make_interval(mins => (extract(minute from timezone('utc', now()) - interval '24 hours')::integer / 5) * 5)
  ) event_total on true
  where p_organization_id is null or organization.id = p_organization_id
  group by organization.id, profile_total.total, domain_total.value, event_total.total
  on conflict (organization_id) do update set
    incidents = excluded.incidents,
    events_24h = excluded.events_24h,
    refreshed_at = excluded.refreshed_at;

  get diagnostics refreshed_count = row_count;
  return refreshed_count;
end;
$$;

revoke all on function public.refresh_instagram_observability_summary_snapshots(uuid)
  from public, anon, authenticated;
grant execute on function public.refresh_instagram_observability_summary_snapshots(uuid)
  to service_role;

create or replace function public.get_instagram_observability_summary(
  p_organization_id uuid
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  snapshot_row public.instagram_observability_summary_snapshots%rowtype;
  worker_summary jsonb;
begin
  if not public.is_organization_member(p_organization_id) then
    raise exception using errcode = '42501', message = 'Permissão insuficiente.';
  end if;

  select * into snapshot_row
  from public.instagram_observability_summary_snapshots
  where organization_id = p_organization_id;

  with worker_kinds(worker_kind) as (
    values ('publication'), ('publication_planner'), ('media_deletion'),
      ('profile_analytics'), ('zernio_sync')
  ), worker_latest as (
    select kind.worker_kind, heartbeat.last_seen_at, heartbeat.status
    from worker_kinds kind
    left join lateral (
      select candidate.last_seen_at, candidate.status
      from public.publication_worker_heartbeats candidate
      where candidate.worker_kind = kind.worker_kind
      order by candidate.last_seen_at desc
      limit 1
    ) heartbeat on true
  )
  select jsonb_build_object(
    'expected', count(*),
    'active', count(*) filter (
      where last_seen_at >= timezone('utc', now()) - interval '120 seconds'
        and status not in ('stopped', 'error')
    ),
    'stale', count(*) filter (
      where last_seen_at is null
        or last_seen_at < timezone('utc', now()) - interval '120 seconds'
        or status in ('stopped', 'error')
    )
  ) into worker_summary
  from worker_latest;

  return jsonb_build_object(
    'incidents', coalesce(snapshot_row.incidents, jsonb_build_object(
      'actionRequired', 0, 'investigating', 0, 'autoRecovering', 0,
      'contained', 0, 'critical', 0, 'affectedProfiles', 0,
      'byDomain', '{}'::jsonb
    )),
    'events24h', coalesce(snapshot_row.events_24h, 0),
    'workers', worker_summary,
    'checkedAt', coalesce(snapshot_row.refreshed_at, timezone('utc', now())),
    'snapshotStale', snapshot_row.refreshed_at is null
      or snapshot_row.refreshed_at < timezone('utc', now()) - interval '15 minutes',
    'retentionDays', 14
  );
end;
$$;

revoke all on function public.get_instagram_observability_summary(uuid)
  from public, anon;
grant execute on function public.get_instagram_observability_summary(uuid)
  to authenticated, service_role;

notify pgrst, 'reload schema';
