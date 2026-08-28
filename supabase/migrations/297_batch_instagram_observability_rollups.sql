-- Evita contenção de escrita no bucket quente. Com mais de cem mil eventos por
-- dia, o upsert por linha disputava repetidamente as mesmas poucas chaves.
drop trigger if exists instagram_observability_events_aggregate_rollup
  on public.instagram_observability_events;

drop function if exists public.aggregate_instagram_observability_event_rollup();

create or replace function public.refresh_instagram_observability_rollups_recent(
  p_lookback_minutes integer default 20
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  lookback_minutes integer := greatest(10, least(coalesce(p_lookback_minutes, 20), 60));
  cutoff timestamptz := date_trunc('hour', timezone('utc', now()) - make_interval(mins => lookback_minutes))
    + make_interval(mins => (extract(minute from timezone('utc', now()) - make_interval(mins => lookback_minutes))::integer / 5) * 5);
  refreshed_rows bigint := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Apenas service_role atualiza os agregados.';
  end if;

  -- Impede duas execuções de manutenção de recalcularem a mesma janela.
  if not pg_try_advisory_xact_lock(hashtext('instagram_observability_rollups_recent')) then
    return jsonb_build_object('skipped', true, 'reason', 'already_running', 'cutoff', cutoff);
  end if;

  insert into public.instagram_observability_rollups_5m (
    organization_id, window_started_at, domain, provider, operation, outcome,
    event_count, duration_sum_ms, duration_min_ms, duration_max_ms
  )
  select
    event.organization_id,
    date_trunc('hour', event.occurred_at)
      + make_interval(mins => (extract(minute from event.occurred_at)::integer / 5) * 5),
    event.domain,
    coalesce(event.provider, 'none'),
    event.event_type,
    coalesce(event.source_status, event.treatment_state::text),
    count(*), 0, null, null
  from public.instagram_observability_events as event
  where event.occurred_at >= cutoff
  group by 1, 2, 3, 4, 5, 6
  on conflict (organization_id, window_started_at, domain, provider, operation, outcome)
  do update set
    event_count = excluded.event_count,
    updated_at = timezone('utc', now());

  get diagnostics refreshed_rows = row_count;
  return jsonb_build_object(
    'skipped', false,
    'cutoff', cutoff,
    'refreshedRows', refreshed_rows
  );
end;
$$;

revoke all on function public.refresh_instagram_observability_rollups_recent(integer)
  from public, anon, authenticated;
grant execute on function public.refresh_instagram_observability_rollups_recent(integer)
  to service_role;

notify pgrst, 'reload schema';
