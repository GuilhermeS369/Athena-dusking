-- Fase E: permite canário direto na VPS sem disputa com o dispatcher Vercel.
-- A fila legada continua intacta; apenas o claim passa a aceitar escopo por
-- organização e a rota pode detectar um executor VPS direto saudável.

create or replace function public.active_profile_analytics_direct_worker_organization_ids(
  p_stale_seconds integer default 120,
  p_worker_prefix text default 'athena-vps-'
)
returns uuid[]
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_service_role_request() then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;
  if p_stale_seconds not between 30 and 3600 then
    raise exception using errcode = '22023', message = 'Janela de heartbeat inválida.';
  end if;

  return coalesce((
    select array_agg(distinct organization_id)
    from public.publication_worker_heartbeats heartbeat
    cross join lateral jsonb_array_elements_text(
      coalesce(heartbeat.metadata -> 'organizationIds', '[]'::jsonb)
    ) configured(organization_id_text)
    cross join lateral (
      select configured.organization_id_text::uuid as organization_id
    ) parsed
    where heartbeat.worker_kind = 'profile_analytics'
      and heartbeat.worker_id like coalesce(nullif(p_worker_prefix, ''), 'athena-vps-') || '%'
      and not heartbeat.dry_run
      and heartbeat.status in ('starting', 'idle', 'processing')
      and heartbeat.last_seen_at >= timezone('utc', now()) - make_interval(secs => p_stale_seconds)
      and heartbeat.metadata ->> 'executionMode' = 'direct'
  ), '{}'::uuid[]);
end;
$$;

create or replace function public.claim_profile_analytics_refresh_job(
  p_worker_id text,
  p_lease_seconds integer default 300,
  p_organization_ids uuid[] default null,
  p_excluded_organization_ids uuid[] default null
)
returns table (
  job_id uuid,
  organization_id uuid,
  total_count integer,
  processed_count integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_service_role_request() then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido.';
  end if;
  if p_lease_seconds not between 30 and 1800 then
    raise exception using errcode = '22023', message = 'Lease deve estar entre 30 e 1800 segundos.';
  end if;
  if p_organization_ids is not null
    and (cardinality(p_organization_ids) = 0 or array_position(p_organization_ids, null) is not null)
  then
    raise exception using errcode = '22023', message = 'Escopo de organizações inválido.';
  end if;
  if p_excluded_organization_ids is not null
    and array_position(p_excluded_organization_ids, null) is not null
  then
    raise exception using errcode = '22023', message = 'Escopo de exclusão inválido.';
  end if;

  return query
  with candidates as (
    select job.id
    from public.profile_analytics_refresh_jobs job
    where job.status in ('pending', 'processing')
      and (p_organization_ids is null or job.organization_id = any(p_organization_ids))
      and (p_excluded_organization_ids is null or not (job.organization_id = any(p_excluded_organization_ids)))
      and (job.lease_until is null or job.lease_until <= timezone('utc', now()) or job.claimed_by = trim(p_worker_id))
      and exists (
        select 1
        from public.profile_analytics_refresh_job_items item
        where item.job_id = job.id
          and item.attempts < item.max_attempts
          and (
            item.status = 'pending'
            or (item.status = 'retry_pending' and coalesce(item.next_attempt_at, timezone('utc', now())) <= timezone('utc', now()))
            or (item.status = 'processing' and coalesce(item.lease_until, '-infinity'::timestamptz) <= timezone('utc', now()))
          )
      )
    order by case job.trigger when 'manual' then 0 when 'connection_sync' then 1 when 'page_view' then 2 else 3 end, job.created_at, job.id
    for update skip locked
    limit 1
  ), claimed as (
    update public.profile_analytics_refresh_jobs job
    set status = 'processing',
        claimed_by = trim(p_worker_id),
        lease_until = timezone('utc', now()) + make_interval(secs => p_lease_seconds),
        started_at = coalesce(job.started_at, timezone('utc', now()))
    from candidates
    where job.id = candidates.id
    returning job.id, job.organization_id, job.total_count, job.processed_count
  )
  select claimed.id, claimed.organization_id, claimed.total_count, claimed.processed_count from claimed;
end;
$$;

revoke all on function public.active_profile_analytics_direct_worker_organization_ids(integer, text) from public, anon, authenticated;
revoke all on function public.claim_profile_analytics_refresh_job(text, integer, uuid[], uuid[]) from public, anon, authenticated;

grant execute on function public.active_profile_analytics_direct_worker_organization_ids(integer, text) to service_role;
grant execute on function public.claim_profile_analytics_refresh_job(text, integer, uuid[], uuid[]) to service_role;

notify pgrst, 'reload schema';
