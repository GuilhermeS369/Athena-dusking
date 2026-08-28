create or replace function public.maintain_instagram_observability_hot_source(
  p_source text,
  p_retention_days integer default 14,
  p_batch_size integer default 500
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  cutoff timestamptz := timezone('utc', now()) - make_interval(days => greatest(14, least(coalesce(p_retention_days, 14), 14)));
  batch_size integer := greatest(50, least(coalesce(p_batch_size, 500), 5000));
  boundary_partition text := 'instagram_observability_events_' || to_char(cutoff::date, 'YYYY_MM_DD');
  partition_day date;
  partition_name text;
  partition_row record;
  affected bigint := 0;
  dropped integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Apenas service_role mantém a observabilidade.';
  end if;

  case p_source
    when 'partitions' then
      for day_offset in 0..7 loop
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
          dropped := dropped + 1;
        end if;
      end loop;
      return jsonb_build_object('source', p_source, 'cutoff', cutoff, 'affected', dropped, 'hasMore', false);

    when 'boundary_events' then
      if to_regclass('public.' || boundary_partition) is not null then
        execute format(
          'with expired as (select ctid from public.%I where occurred_at < $1 order by occurred_at limit $2) '
          || 'delete from public.%I target using expired where target.ctid = expired.ctid',
          boundary_partition, boundary_partition
        ) using cutoff, batch_size;
        get diagnostics affected = row_count;
      end if;

    when 'default_events' then
      with expired as (
        select ctid from public.instagram_observability_events_default
        where occurred_at < cutoff order by occurred_at limit batch_size
      )
      delete from public.instagram_observability_events_default target
      using expired where target.ctid = expired.ctid;
      get diagnostics affected = row_count;

    when 'event_rollups' then
      with expired as (
        select ctid from public.instagram_observability_rollups_5m
        where window_started_at < cutoff order by window_started_at limit batch_size
      )
      delete from public.instagram_observability_rollups_5m target
      using expired where target.ctid = expired.ctid;
      get diagnostics affected = row_count;

    when 'worker_rollups' then
      with expired as (
        select ctid from public.instagram_worker_rollups_5m
        where window_started_at < cutoff order by window_started_at limit batch_size
      )
      delete from public.instagram_worker_rollups_5m target
      using expired where target.ctid = expired.ctid;
      get diagnostics affected = row_count;

    when 'incident_actions' then
      with expired as (
        select ctid from public.instagram_observability_incident_actions
        where created_at < cutoff order by created_at limit batch_size
      )
      delete from public.instagram_observability_incident_actions target
      using expired where target.ctid = expired.ctid;
      get diagnostics affected = row_count;

    when 'resolved_incidents' then
      with expired as (
        select id from public.instagram_observability_incidents
        where treatment_state = 'resolved'
          and greatest(last_seen_at, coalesce(resolved_at, last_seen_at)) < cutoff
        order by last_seen_at
        limit least(batch_size, 100)
        for update skip locked
      )
      delete from public.instagram_observability_incidents target
      using expired where target.id = expired.id;
      get diagnostics affected = row_count;

    else
      raise exception using errcode = '22023', message = 'Fonte quente inválida.';
  end case;

  return jsonb_build_object(
    'source', p_source,
    'cutoff', cutoff,
    'affected', affected,
    'hasMore', affected >= case when p_source = 'resolved_incidents' then least(batch_size, 100) else batch_size end
  );
end;
$$;

revoke all on function public.maintain_instagram_observability_hot_source(text,integer,integer)
  from public, anon, authenticated;
grant execute on function public.maintain_instagram_observability_hot_source(text,integer,integer)
  to service_role;

notify pgrst, 'reload schema';
