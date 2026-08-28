-- O backfill 300 calculou a cardinalidade exata de perfis. Nos ciclos quentes,
-- preservamos esse valor e atualizamos somente agregados baratos. A associação
-- incidente-perfil não deve ser percorrida a cada cinco minutos.

create or replace function public.refresh_instagram_observability_summary_snapshots(
  p_organization_id uuid default null
) returns integer
language plpgsql security definer set search_path = public as $$
declare refreshed_count integer;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Somente service_role pode recompor resumos.';
  end if;

  with target_organizations as materialized (
    select organization.id
    from public.organizations organization
    where p_organization_id is null or organization.id = p_organization_id
  ), incident_stats as materialized (
    select incident.organization_id,
      count(*) filter (where incident.treatment_state = 'action_required')::bigint as action_required,
      count(*) filter (where incident.treatment_state = 'investigating')::bigint as investigating,
      count(*) filter (where incident.treatment_state = 'auto_recovering')::bigint as auto_recovering,
      count(*) filter (where incident.treatment_state = 'contained')::bigint as contained,
      count(*) filter (where incident.severity = 'critical')::bigint as critical
    from public.instagram_observability_incidents incident
    join target_organizations target on target.id = incident.organization_id
    where incident.treatment_state <> 'resolved'
    group by incident.organization_id
  ), domain_stats as materialized (
    select grouped.organization_id,
      jsonb_object_agg(grouped.domain::text, grouped.total) as value
    from (
      select incident.organization_id, incident.domain, count(*)::bigint as total
      from public.instagram_observability_incidents incident
      join target_organizations target on target.id = incident.organization_id
      where incident.treatment_state <> 'resolved'
      group by incident.organization_id, incident.domain
    ) grouped
    group by grouped.organization_id
  ), event_stats as materialized (
    select rollup.organization_id, sum(rollup.event_count)::bigint as total
    from public.instagram_observability_rollups_5m rollup
    join target_organizations target on target.id = rollup.organization_id
    where rollup.window_started_at >= date_trunc('hour', timezone('utc', now()) - interval '24 hours')
      + make_interval(mins => (extract(minute from timezone('utc', now()) - interval '24 hours')::integer / 5) * 5)
    group by rollup.organization_id
  )
  insert into public.instagram_observability_summary_snapshots (
    organization_id, incidents, events_24h, refreshed_at
  )
  select target.id,
    jsonb_build_object(
      'actionRequired', coalesce(incident.action_required, 0),
      'investigating', coalesce(incident.investigating, 0),
      'autoRecovering', coalesce(incident.auto_recovering, 0),
      'contained', coalesce(incident.contained, 0),
      'critical', coalesce(incident.critical, 0),
      'affectedProfiles', coalesce((snapshot.incidents ->> 'affectedProfiles')::bigint, 0),
      'byDomain', coalesce(domain.value, '{}'::jsonb)
    ),
    coalesce(event.total, 0),
    timezone('utc', now())
  from target_organizations target
  left join incident_stats incident on incident.organization_id = target.id
  left join domain_stats domain on domain.organization_id = target.id
  left join event_stats event on event.organization_id = target.id
  left join public.instagram_observability_summary_snapshots snapshot
    on snapshot.organization_id = target.id
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

notify pgrst, 'reload schema';
