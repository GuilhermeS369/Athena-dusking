-- Recuperação coordenada de slots coletivos e seleção round-robin entre organizações.
-- A recuperação começa desabilitada por padrão: só organizações explicitamente
-- habilitadas saem do estado at_risk, sempre dentro de uma janela segura.

create table public.publication_slot_recovery_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  enabled boolean not null default false,
  max_items_per_cycle integer not null default 5 check (max_items_per_cycle between 1 and 100),
  min_safe_window_seconds integer not null default 120 check (min_safe_window_seconds between 30 and 3600),
  max_recovery_delay_seconds integer not null default 900 check (max_recovery_delay_seconds between 60 and 86400),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique nulls not distinct (organization_id)
);

create trigger publication_slot_recovery_settings_set_updated_at
before update on public.publication_slot_recovery_settings
for each row execute function public.set_updated_at();

alter table public.publication_slot_recovery_settings enable row level security;
revoke all on public.publication_slot_recovery_settings from public, anon, authenticated;
grant all on public.publication_slot_recovery_settings to service_role;

insert into public.publication_slot_recovery_settings (
  organization_id, enabled, max_items_per_cycle, min_safe_window_seconds, max_recovery_delay_seconds
) values (null, false, 5, 120, 900)
on conflict (organization_id) do nothing;

create or replace function public.claim_publication_slot_recovery_items(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 120
)
returns table (
  id uuid,
  organization_id uuid,
  batch_id uuid,
  profile_id uuid,
  format public.publication_format,
  status public.publication_item_status,
  execute_at timestamptz,
  caption text,
  idempotency_key text,
  attempt_count integer,
  creation_id text,
  lease_until timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  now_at timestamptz := timezone('utc', now());
begin
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido';
  end if;
  if p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Limite de recuperação deve estar entre 1 e 100';
  end if;
  if p_lease_seconds not between 30 and 900 then
    raise exception using errcode = '22023', message = 'Lease deve estar entre 30 e 900 segundos';
  end if;

  return query
  with eligible as (
    select
      item_row.id,
      item_row.organization_id,
      item_row.execute_at,
      item_row.created_at,
      settings.max_items_per_cycle,
      row_number() over (
        partition by item_row.organization_id
        order by item_row.execute_at, item_row.created_at, item_row.id
      ) as organization_position
    from public.publication_items item_row
    join public.publication_slot_risk_incidents incident
      on incident.organization_id = item_row.organization_id
      and incident.batch_id = item_row.batch_id
      and incident.slot_execute_at = item_row.execute_at
      and incident.state = 'at_risk'
    join lateral (
      select setting.*
      from public.publication_slot_recovery_settings setting
      where setting.enabled
        and (setting.organization_id = item_row.organization_id or setting.organization_id is null)
      order by (setting.organization_id is not null) desc, setting.updated_at desc, setting.id desc
      limit 1
    ) settings on true
    where item_row.idempotency_key like 'bulk:%'
      and item_row.status in ('waiting', 'ready')
      and item_row.creation_id is null
      and (item_row.next_attempt_at is null or item_row.next_attempt_at <= now_at)
      and (item_row.lease_until is null or item_row.lease_until <= now_at)
      and item_row.execute_at >= now_at - make_interval(secs => settings.max_recovery_delay_seconds)
      and (
        incident.next_slot_execute_at is null
        or incident.next_slot_execute_at >= now_at + make_interval(secs => settings.min_safe_window_seconds)
      )
  ), selected as (
    select eligible.id
    from eligible
    where eligible.organization_position <= eligible.max_items_per_cycle
    order by eligible.organization_position, eligible.execute_at, eligible.organization_id, eligible.id
    limit p_limit
  ), candidates as (
    select item_row.id
    from public.publication_items item_row
    join selected on selected.id = item_row.id
    for update of item_row skip locked
  ), claimed as (
    update public.publication_items item_row
    set status = 'preparing',
        claimed_by = trim(p_worker_id),
        lease_until = now_at + make_interval(secs => p_lease_seconds),
        next_attempt_at = null,
        attempt_count = item_row.attempt_count + 1,
        last_error_code = null,
        last_error_message = null
    from candidates
    where item_row.id = candidates.id
    returning item_row.id, item_row.organization_id, item_row.batch_id, item_row.profile_id,
      item_row.format, item_row.status, item_row.execute_at, item_row.caption,
      item_row.idempotency_key, item_row.attempt_count, item_row.creation_id, item_row.lease_until
  ), updated_incidents as (
    update public.publication_slot_risk_incidents incident
    set decision_reason = 'coordinated_recovery_in_progress',
        last_worker_id = trim(p_worker_id)
    where exists (
      select 1 from claimed
      where claimed.organization_id = incident.organization_id
        and claimed.batch_id = incident.batch_id
        and claimed.execute_at = incident.slot_execute_at
    )
      and incident.state = 'at_risk'
  ), updated_batches as (
    update public.publication_batches batch_row
    set status = 'processing'
    where batch_row.id in (select distinct claimed.batch_id from claimed)
      and batch_row.status in ('queued', 'validating')
  )
  select * from claimed;
end;
$$;

create or replace function public.finalize_publication_slot_recovery_incidents(
  p_worker_id text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  resolved_count integer;
begin
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido';
  end if;

  with resolved as (
    update public.publication_slot_risk_incidents incident
    set state = 'recovered',
        decision_reason = 'coordinated_recovery_completed',
        last_worker_id = trim(p_worker_id),
        resolved_at = timezone('utc', now())
    where incident.state = 'at_risk'
      and incident.decision_reason = 'coordinated_recovery_in_progress'
      and not exists (
        select 1
        from public.publication_items item_row
        where item_row.organization_id = incident.organization_id
          and item_row.batch_id = incident.batch_id
          and item_row.execute_at = incident.slot_execute_at
          and item_row.idempotency_key like 'bulk:%'
          and item_row.status <> 'published'
      )
    returning incident.id
  )
  select count(*)::integer into resolved_count from resolved;

  return resolved_count;
end;
$$;

-- Round-robin global: a primeira publicação elegível de cada organização vem
-- antes da segunda de qualquer organização. O rate limiter já existente segue
-- aplicando os guardrails por perfil/provedor antes da chamada externa.
create or replace function public.claim_publication_items(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 120
)
returns table (
  id uuid,
  organization_id uuid,
  batch_id uuid,
  profile_id uuid,
  format public.publication_format,
  status public.publication_item_status,
  execute_at timestamptz,
  caption text,
  idempotency_key text,
  attempt_count integer,
  creation_id text,
  lease_until timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then raise exception using errcode = '22023', message = 'Identificador de worker inválido'; end if;
  if p_limit not between 1 and 100 then raise exception using errcode = '22023', message = 'Limite de claim deve estar entre 1 e 100'; end if;
  if p_lease_seconds not between 30 and 900 then raise exception using errcode = '22023', message = 'Lease deve estar entre 30 e 900 segundos'; end if;

  return query
  with eligible as (
    select item_row.id, item_row.organization_id, item_row.execute_at, item_row.created_at,
      row_number() over (
        partition by item_row.organization_id
        order by coalesce(item_row.execute_at, item_row.created_at), item_row.created_at, item_row.id
      ) as organization_position
    from public.publication_items item_row
    where item_row.status in ('ready', 'waiting', 'preparing', 'failed')
      and (item_row.status <> 'failed' or item_row.attempt_count < 5)
      and (item_row.execute_at is null or item_row.execute_at <= timezone('utc', now()))
      and (item_row.next_attempt_at is null or item_row.next_attempt_at <= timezone('utc', now()))
      and (item_row.lease_until is null or item_row.lease_until <= timezone('utc', now()))
      and not exists (
        select 1 from public.publication_batch_circuit_breakers breaker
        where breaker.batch_id = item_row.batch_id and breaker.paused_at is not null
      )
      and not exists (
        select 1 from public.publication_slot_risk_incidents risk
        where risk.organization_id = item_row.organization_id
          and risk.batch_id = item_row.batch_id
          and risk.slot_execute_at = item_row.execute_at
          and risk.state = 'at_risk'
          and item_row.idempotency_key like 'bulk:%'
      )
  ), selected as (
    select eligible.id
    from eligible
    order by eligible.organization_position, coalesce(eligible.execute_at, eligible.created_at), eligible.organization_id, eligible.id
    limit p_limit
  ), candidates as (
    select item_row.id
    from public.publication_items item_row
    join selected on selected.id = item_row.id
    for update of item_row skip locked
  ), claimed as (
    update public.publication_items item_row
    set status = 'preparing',
        claimed_by = trim(p_worker_id),
        lease_until = timezone('utc', now()) + make_interval(secs => p_lease_seconds),
        next_attempt_at = null,
        attempt_count = item_row.attempt_count + case when item_row.creation_id is null or item_row.status = 'failed' then 1 else 0 end
    from candidates
    where item_row.id = candidates.id
    returning item_row.id, item_row.organization_id, item_row.batch_id, item_row.profile_id,
      item_row.format, item_row.status, item_row.execute_at, item_row.caption,
      item_row.idempotency_key, item_row.attempt_count, item_row.creation_id, item_row.lease_until
  ), updated_batches as (
    update public.publication_batches batch_row
    set status = 'processing'
    where batch_row.id in (select distinct claimed.batch_id from claimed)
      and batch_row.status in ('queued', 'validating')
  )
  select * from claimed;
end;
$$;

revoke all on function public.claim_publication_slot_recovery_items(text, integer, integer) from public, anon, authenticated;
revoke all on function public.finalize_publication_slot_recovery_incidents(text) from public, anon, authenticated;
revoke all on function public.claim_publication_items(text, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_publication_slot_recovery_items(text, integer, integer) to service_role;
grant execute on function public.finalize_publication_slot_recovery_incidents(text) to service_role;
grant execute on function public.claim_publication_items(text, integer, integer) to service_role;

notify pgrst, 'reload schema';
