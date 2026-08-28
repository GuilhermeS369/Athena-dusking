create table if not exists public.instagram_observability_api_rollups_5m (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  bucket_at timestamptz not null,
  route text not null check (char_length(route) between 1 and 180),
  status_code integer not null check (status_code between 100 and 599),
  request_count bigint not null default 0 check (request_count >= 0),
  error_count bigint not null default 0 check (error_count >= 0),
  duration_ms_sum bigint not null default 0 check (duration_ms_sum >= 0),
  duration_ms_max integer not null default 0 check (duration_ms_max >= 0),
  payload_bytes_sum bigint not null default 0 check (payload_bytes_sum >= 0),
  payload_bytes_max integer not null default 0 check (payload_bytes_max >= 0),
  primary key (organization_id, bucket_at, route, status_code)
);

create index if not exists instagram_observability_api_rollups_time_idx
  on public.instagram_observability_api_rollups_5m (bucket_at desc, route);

create or replace function public.instagram_record_observability_api_metric(
  p_organization_id uuid,
  p_route text,
  p_status_code integer,
  p_duration_ms integer,
  p_payload_bytes integer
) returns void
language plpgsql security definer set search_path = public as $$
declare
  bucket timestamptz := date_trunc('hour', timezone('utc', now()))
    + floor(extract(minute from timezone('utc', now())) / 5) * interval '5 minutes';
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Somente service_role pode registrar telemetria.';
  end if;
  if p_status_code not between 100 and 599
    or p_duration_ms not between 0 and 600000
    or p_payload_bytes not between 0 and 10485760
    or char_length(trim(coalesce(p_route, ''))) not between 1 and 180 then
    raise exception using errcode = '22023', message = 'Métrica de API inválida.';
  end if;
  insert into public.instagram_observability_api_rollups_5m (
    organization_id, bucket_at, route, status_code, request_count, error_count,
    duration_ms_sum, duration_ms_max, payload_bytes_sum, payload_bytes_max
  ) values (
    p_organization_id, bucket, trim(p_route), p_status_code, 1,
    case when p_status_code >= 500 then 1 else 0 end,
    p_duration_ms, p_duration_ms, p_payload_bytes, p_payload_bytes
  ) on conflict (organization_id, bucket_at, route, status_code) do update set
    request_count = instagram_observability_api_rollups_5m.request_count + 1,
    error_count = instagram_observability_api_rollups_5m.error_count + excluded.error_count,
    duration_ms_sum = instagram_observability_api_rollups_5m.duration_ms_sum + excluded.duration_ms_sum,
    duration_ms_max = greatest(instagram_observability_api_rollups_5m.duration_ms_max, excluded.duration_ms_max),
    payload_bytes_sum = instagram_observability_api_rollups_5m.payload_bytes_sum + excluded.payload_bytes_sum,
    payload_bytes_max = greatest(instagram_observability_api_rollups_5m.payload_bytes_max, excluded.payload_bytes_max);
end;
$$;

create or replace function public.instagram_purge_observability_api_metrics(
  p_retention_days integer default 14
) returns bigint
language plpgsql security definer set search_path = public as $$
declare deleted_count bigint;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Somente service_role pode executar manutenção.';
  end if;
  delete from public.instagram_observability_api_rollups_5m
  where bucket_at < timezone('utc', now()) - greatest(1, least(14, p_retention_days)) * interval '1 day';
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

alter table public.instagram_observability_api_rollups_5m enable row level security;
revoke all on public.instagram_observability_api_rollups_5m from anon, authenticated;
grant all on public.instagram_observability_api_rollups_5m to service_role;
revoke all on function public.instagram_record_observability_api_metric(uuid,text,integer,integer,integer) from public, anon, authenticated;
grant execute on function public.instagram_record_observability_api_metric(uuid,text,integer,integer,integer) to service_role;
revoke all on function public.instagram_purge_observability_api_metrics(integer) from public, anon, authenticated;
grant execute on function public.instagram_purge_observability_api_metrics(integer) to service_role;

notify pgrst, 'reload schema';
