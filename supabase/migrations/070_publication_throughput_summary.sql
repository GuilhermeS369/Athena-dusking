-- Métricas agregadas de throughput de publicação para observabilidade.
-- O objetivo é medir vazão real recente sem carregar publicações individuais.

create or replace function public.get_publication_throughput_summary(
  p_organization_id uuid,
  p_hours integer default 24
)
returns table (
  window_label text,
  window_start timestamptz,
  published_count integer,
  failed_count integer,
  attempted_count integer,
  unique_profiles integer,
  average_publish_lag_seconds integer,
  max_publish_lag_seconds integer
)
language sql
stable
security definer
set search_path = public
as $$
  with bounds as (
    select
      timezone('utc', now()) as now_at,
      greatest(1, least(coalesce(p_hours, 24), 168)) as hours_back
  ), windows as (
    select '15m'::text as window_label, now_at - interval '15 minutes' as window_start from bounds
    union all select '1h', now_at - interval '1 hour' from bounds
    union all select '24h', now_at - interval '24 hours' from bounds
    union all select 'custom', now_at - make_interval(hours => hours_back) from bounds
  ), eligible_items as (
    select item.*
    from public.publication_items item
    where item.organization_id = p_organization_id
      and (auth.role() = 'service_role' or public.is_organization_member(p_organization_id))
      and (
        (item.status = 'published' and item.published_at is not null and item.published_at >= (select min(window_start) from windows))
        or (item.status = 'failed' and item.updated_at >= (select min(window_start) from windows))
      )
  )
  select
    window_row.window_label,
    window_row.window_start,
    count(*) filter (where item.status = 'published' and item.published_at >= window_row.window_start)::integer as published_count,
    count(*) filter (where item.status = 'failed' and item.updated_at >= window_row.window_start)::integer as failed_count,
    count(*) filter (
      where (item.status = 'published' and item.published_at >= window_row.window_start)
         or (item.status = 'failed' and item.updated_at >= window_row.window_start)
    )::integer as attempted_count,
    count(distinct item.profile_id) filter (
      where item.status = 'published' and item.published_at >= window_row.window_start
    )::integer as unique_profiles,
    coalesce(avg(greatest(0, extract(epoch from (item.published_at - item.execute_at))::integer)) filter (
      where item.status = 'published'
        and item.published_at >= window_row.window_start
        and item.execute_at is not null
    ), 0)::integer as average_publish_lag_seconds,
    coalesce(max(greatest(0, extract(epoch from (item.published_at - item.execute_at))::integer)) filter (
      where item.status = 'published'
        and item.published_at >= window_row.window_start
        and item.execute_at is not null
    ), 0)::integer as max_publish_lag_seconds
  from windows window_row
  left join eligible_items item on true
  group by window_row.window_label, window_row.window_start
  order by case window_row.window_label when '15m' then 1 when '1h' then 2 when '24h' then 3 else 4 end;
$$;

revoke all on function public.get_publication_throughput_summary(uuid, integer) from public, anon;
grant execute on function public.get_publication_throughput_summary(uuid, integer) to authenticated, service_role;
