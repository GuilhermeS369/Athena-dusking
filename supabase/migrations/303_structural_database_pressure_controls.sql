-- Controles estruturais de pressão: sinal leve para o gerador, prioridade da
-- publicação atual e snapshot assíncrono do resumo operacional.

create index if not exists publication_items_generation_pressure_idx
  on public.publication_items (execute_at, id)
  where archived_at is null
    and pipeline_version = 2
    and status in ('waiting', 'ready')
    and execute_at is not null;

create index if not exists publication_items_zernio_ready_window_idx
  on public.publication_items (execute_at, organization_id, profile_id, id)
  where pipeline_version = 2
    and status in ('waiting', 'ready')
    and creation_id is null
    and preparation_status = 'ready';

create index if not exists publication_items_zernio_pending_window_idx
  on public.publication_items (execute_at, organization_id, profile_id, id)
  where pipeline_version = 2
    and status in ('waiting', 'ready')
    and creation_id is null
    and preparation_status = 'pending';

create or replace function public.get_publication_generation_pressure_signal(
  p_critical_delay_seconds integer default 60
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  oldest_due_at timestamptz;
  checked_at timestamptz := timezone('utc', now());
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Somente service_role pode consultar pressão global.';
  end if;
  if p_critical_delay_seconds not between 30 and 3600 then
    raise exception using errcode = '22023', message = 'Limite de atraso crítico inválido.';
  end if;

  select item.execute_at into oldest_due_at
  from public.publication_items item
  where item.archived_at is null
    and item.pipeline_version = 2
    and item.status in ('waiting', 'ready')
    and item.execute_at is not null
    and item.execute_at <= checked_at - make_interval(secs => p_critical_delay_seconds)
  order by item.execute_at, item.id
  limit 1;

  return jsonb_build_object(
    'criticalDelay', oldest_due_at is not null,
    'oldestDueAt', oldest_due_at,
    'overdueCurrent', case when oldest_due_at is null then 0 else 1 end,
    'checkedAt', checked_at
  );
end;
$$;

revoke all on function public.get_publication_generation_pressure_signal(integer)
  from public, anon, authenticated;
grant execute on function public.get_publication_generation_pressure_signal(integer)
  to service_role;

create table if not exists public.publication_queue_operational_snapshots (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  rows jsonb not null default '[]'::jsonb check (jsonb_typeof(rows) = 'array'),
  generated_at timestamptz not null default timezone('utc', now())
);

alter table public.publication_queue_operational_snapshots enable row level security;
revoke all on public.publication_queue_operational_snapshots from public, anon, authenticated;
grant all on public.publication_queue_operational_snapshots to service_role;

create or replace function public.refresh_publication_queue_operational_snapshots()
returns integer
language plpgsql security definer set search_path = public as $$
declare
  affected integer;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Somente service_role pode recompor o resumo da fila.';
  end if;

  insert into public.publication_queue_operational_snapshots (organization_id, rows, generated_at)
  select summary.organization_id,
    jsonb_agg(to_jsonb(summary) order by summary.status),
    timezone('utc', now())
  from public.get_publication_queue_operational_summary(null) summary
  group by summary.organization_id
  on conflict (organization_id) do update set
    rows = excluded.rows,
    generated_at = excluded.generated_at;

  get diagnostics affected = row_count;
  return affected;
end;
$$;

create or replace function public.get_publication_queue_operational_snapshot(
  p_organization_id uuid default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  result_rows jsonb;
  result_generated_at timestamptz;
begin
  if auth.role() <> 'service_role'
    and (p_organization_id is null or not public.is_organization_member(p_organization_id)) then
    raise exception using errcode = '42501', message = 'Permissão insuficiente.';
  end if;

  if p_organization_id is null then
    select coalesce(jsonb_agg(element.value order by element.value ->> 'organization_id', element.value ->> 'status'), '[]'::jsonb),
      min(snapshot.generated_at)
    into result_rows, result_generated_at
    from public.publication_queue_operational_snapshots snapshot
    cross join lateral jsonb_array_elements(snapshot.rows) element(value);
  else
    select snapshot.rows, snapshot.generated_at
    into result_rows, result_generated_at
    from public.publication_queue_operational_snapshots snapshot
    where snapshot.organization_id = p_organization_id;
  end if;

  return jsonb_build_object(
    'rows', coalesce(result_rows, '[]'::jsonb),
    'generatedAt', result_generated_at,
    'stale', result_generated_at is null
      or result_generated_at < timezone('utc', now()) - interval '10 minutes'
  );
end;
$$;

revoke all on function public.refresh_publication_queue_operational_snapshots()
  from public, anon, authenticated;
grant execute on function public.refresh_publication_queue_operational_snapshots()
  to service_role;
revoke all on function public.get_publication_queue_operational_snapshot(uuid)
  from public, anon;
grant execute on function public.get_publication_queue_operational_snapshot(uuid)
  to authenticated, service_role;

-- Itens aceitos pelo provedor e publicações dentro dos últimos 15 minutos são
-- faixa crítica. Backlog mais antigo usa no máximo 25% do claim (mínimo 1).
create or replace function public.claim_publication_items(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 120
)
returns table (
  id uuid, organization_id uuid, batch_id uuid, profile_id uuid,
  format public.publication_format, status public.publication_item_status,
  execute_at timestamptz, caption text, idempotency_key text,
  attempt_count integer, creation_id text, lease_until timestamptz
)
language plpgsql security definer set search_path = public as $$
begin
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido';
  end if;
  if p_limit not between 1 and 100 or p_lease_seconds not between 30 and 900 then
    raise exception using errcode = '22023', message = 'Limite ou lease de claim inválido';
  end if;

  return query
  with eligible_source as (
    select item.id, item.organization_id, item.profile_id, item.execute_at, item.created_at,
      case
        when item.creation_id is not null then 0
        when item.execute_at is null or item.execute_at >= timezone('utc', now()) - interval '15 minutes' then 0
        else 1
      end as priority_band
    from public.publication_items item
    where item.status in ('ready', 'waiting', 'preparing', 'failed')
      and (item.status <> 'failed' or (item.attempt_count < 5 and item.next_attempt_at is not null))
      and (item.execute_at is null or item.execute_at <= timezone('utc', now()))
      and (item.next_attempt_at is null or item.next_attempt_at <= timezone('utc', now()))
      and (item.lease_until is null or item.lease_until <= timezone('utc', now()))
      and (item.pipeline_version = 1 or item.creation_id is not null or item.preparation_status = 'ready')
      and not (coalesce(item.zernio_recovery_count, 0) > 0 and item.creation_id is null)
      and not exists (
        select 1 from public.publication_batch_circuit_breakers breaker
        where breaker.batch_id = item.batch_id and breaker.paused_at is not null
      )
      and not (
        item.pipeline_version = 1 and item.creation_id is null
        and item.idempotency_key like 'bulk:%'
        and exists (
          select 1 from public.publication_slot_risk_incidents risk
          where risk.organization_id = item.organization_id
            and risk.batch_id = item.batch_id
            and risk.slot_execute_at = item.execute_at and risk.state = 'at_risk'
        )
      )
  ), eligible as (
    select source.*,
      row_number() over (partition by source.organization_id order by source.priority_band, coalesce(source.execute_at, source.created_at), source.id) as org_position,
      row_number() over (partition by source.profile_id order by source.priority_band, coalesce(source.execute_at, source.created_at), source.id) as profile_position,
      row_number() over (partition by source.priority_band order by coalesce(source.execute_at, source.created_at), source.organization_id, source.id) as band_position
    from eligible_source source
  ), selected as (
    select eligible.id from eligible
    where eligible.priority_band = 0
       or eligible.band_position <= greatest(1, ceil(p_limit * 0.25)::integer)
    order by eligible.priority_band, eligible.profile_position, eligible.org_position,
      coalesce(eligible.execute_at, eligible.created_at), eligible.organization_id, eligible.id
    limit p_limit
  ), locked as (
    select item.id from public.publication_items item
    join selected on selected.id = item.id
    for update of item skip locked
  ), claimed as (
    update public.publication_items item
    set status = 'preparing', claimed_by = trim(p_worker_id),
        lease_until = timezone('utc', now()) + make_interval(secs => p_lease_seconds),
        next_attempt_at = null,
        attempt_count = item.attempt_count + case when item.creation_id is null or item.status = 'failed' then 1 else 0 end
    from locked where item.id = locked.id
    returning item.id, item.organization_id, item.batch_id, item.profile_id,
      item.format, item.status, item.execute_at, item.caption, item.idempotency_key,
      item.attempt_count, item.creation_id, item.lease_until
  ), updated_batches as (
    update public.publication_batches batch set status = 'processing'
    where batch.id in (select distinct claimed.batch_id from claimed)
      and batch.status in ('queued', 'validating')
  )
  select * from claimed;
end;
$$;

revoke all on function public.claim_publication_items(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_publication_items(text, integer, integer)
  to service_role;

-- O plano compacto inteiro permanece salvo, mas somente slots nas próximas
-- 48 horas ficam elegíveis à materialização. O mesmo chunk volta a ficar
-- elegível naturalmente conforme o horizonte avança.
create or replace function public.claim_bulk_rotation_generation_chunks(
  p_worker_id text,
  p_limit integer default 1,
  p_lease_seconds integer default 300,
  p_max_failures integer default 3
)
returns table (
  id uuid, plan_id uuid, plan_profile_id uuid, organization_id uuid,
  profile_id uuid, status text, slot_start text, slot_count text,
  next_slot_index text, attempt_count integer, lease_until timestamptz
)
language plpgsql security definer set search_path = public as $$
declare
  affected_plan_id uuid;
  affected_plan_ids uuid[] := '{}'::uuid[];
begin
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido.';
  end if;
  if p_limit not between 1 and 50 or p_lease_seconds not between 60 and 3600
    or p_max_failures not between 1 and 20 then
    raise exception using errcode = '22023', message = 'Parâmetros de claim inválidos.';
  end if;

  with paused_chunks as (
    update public.bulk_publication_generation_chunks chunk
    set status = 'paused', claimed_by = null, lease_until = null,
        last_error_message = 'Perfil offline; geração suspensa sem consumir retry.'
    from public.bulk_publication_plan_profiles profile_plan
    join public.instagram_profiles profile on profile.id = profile_plan.profile_id
    where chunk.plan_profile_id = profile_plan.id
      and chunk.status in ('queued', 'processing', 'failed')
      and chunk.retry_exhausted_at is null
      and (chunk.claimed_by is null or chunk.lease_until is null or chunk.lease_until <= timezone('utc', now()))
      and (profile.deleted_at is not null or profile.status <> 'online')
    returning chunk.plan_id, chunk.plan_profile_id
  ), suspended_profiles as (
    update public.bulk_publication_plan_profiles profile_plan
    set status = 'suspended', suspended_at = coalesce(profile_plan.suspended_at, timezone('utc', now())),
        suspension_reason = 'Perfil offline; geração suspensa sem consumir retry.'
    where profile_plan.id in (select paused.plan_profile_id from paused_chunks paused)
    returning profile_plan.plan_id
  )
  select coalesce(array_agg(distinct suspended.plan_id), '{}'::uuid[])
  into affected_plan_ids from suspended_profiles suspended;

  foreach affected_plan_id in array affected_plan_ids loop
    perform public.refresh_bulk_rotation_plan_state(affected_plan_id);
  end loop;

  return query
  with candidates as (
    select chunk.id
    from public.bulk_publication_generation_chunks chunk
    join public.bulk_publication_plans plan on plan.id = chunk.plan_id
    join public.bulk_publication_plan_profiles profile_plan on profile_plan.id = chunk.plan_profile_id
    join public.instagram_profiles profile on profile.id = chunk.profile_id
    where plan.status in ('queued', 'generating')
      and profile_plan.status in ('queued', 'generating')
      and profile.deleted_at is null and profile.status = 'online'
      and chunk.status in ('queued', 'processing', 'failed')
      and chunk.retry_exhausted_at is null
      and chunk.consecutive_failure_count < p_max_failures
      and (chunk.lease_until is null or chunk.lease_until <= timezone('utc', now()))
      and profile_plan.schedule_base_at
        + ((((chunk.next_slot_index + 1) * plan.interval_minutes::bigint)::text || ' minutes')::interval)
          <= timezone('utc', now()) + interval '48 hours'
    order by plan.created_at, plan.id, profile_plan.ordinal, chunk.chunk_ordinal, chunk.id
    for update of chunk skip locked limit p_limit
  ), claimed as (
    update public.bulk_publication_generation_chunks chunk
    set status = 'processing', claimed_by = trim(p_worker_id),
        lease_until = timezone('utc', now()) + make_interval(secs => p_lease_seconds),
        attempt_count = chunk.attempt_count + 1, last_error_message = null
    from candidates where chunk.id = candidates.id returning chunk.*
  ), activated_profiles as (
    update public.bulk_publication_plan_profiles profile_plan set status = 'generating'
    where profile_plan.id in (select claimed.plan_profile_id from claimed)
    returning profile_plan.plan_id
  ), activated_plans as (
    update public.bulk_publication_plans plan
    set status = 'generating', started_at = coalesce(plan.started_at, timezone('utc', now())), completed_at = null
    where plan.id in (select activated.plan_id from activated_profiles activated)
    returning plan.id
  )
  select claimed.id, claimed.plan_id, claimed.plan_profile_id, claimed.organization_id,
    claimed.profile_id, claimed.status, claimed.slot_start::text, claimed.slot_count::text,
    claimed.next_slot_index::text, claimed.attempt_count, claimed.lease_until
  from claimed;
end;
$$;

revoke all on function public.claim_bulk_rotation_generation_chunks(text,integer,integer,integer)
  from public, anon, authenticated;
grant execute on function public.claim_bulk_rotation_generation_chunks(text,integer,integer,integer)
  to service_role;

create or replace function public.process_bulk_rotation_generation_chunk(
  p_chunk_id uuid,
  p_worker_id text,
  p_step_size integer default 50
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  chunk_row public.bulk_publication_generation_chunks%rowtype;
  profile_plan public.bulk_publication_plan_profiles%rowtype;
  plan_row public.bulk_publication_plans%rowtype;
  range_start bigint;
  range_end bigint;
  horizon_slot_exclusive bigint;
  inserted_count bigint := 0;
  materialized_count bigint := 0;
  completed boolean;
begin
  if p_step_size not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Passo adaptativo deve estar entre 1 e 100 slots.';
  end if;
  select * into chunk_row from public.bulk_publication_generation_chunks chunk
  where chunk.id = p_chunk_id and chunk.claimed_by = trim(p_worker_id)
    and chunk.status = 'processing' for update;
  if chunk_row.id is null then
    raise exception using errcode = 'P0002', message = 'Chunk compacto não encontrado ou pertence a outro worker.';
  end if;
  select * into profile_plan from public.bulk_publication_plan_profiles
  where id = chunk_row.plan_profile_id for update;
  select * into plan_row from public.bulk_publication_plans where id = chunk_row.plan_id;
  if profile_plan.id is null or plan_row.id is null or plan_row.status not in ('queued', 'generating') then
    raise exception using errcode = 'P0002', message = 'Plano compacto não está disponível para geração.';
  end if;

  if not exists (
    select 1 from public.instagram_profiles profile
    where profile.id = chunk_row.profile_id and profile.organization_id = chunk_row.organization_id
      and profile.deleted_at is null and profile.status = 'online'
  ) then
    update public.bulk_publication_generation_chunks
    set status = 'paused', claimed_by = null, lease_until = null,
        attempt_count = greatest(attempt_count - 1, 0),
        last_error_message = 'Perfil offline; geração suspensa sem consumir retry.'
    where id = chunk_row.id;
    update public.bulk_publication_plan_profiles
    set status = 'suspended', suspended_at = coalesce(suspended_at, timezone('utc', now())),
        suspension_reason = 'Perfil offline; retomada manual necessária.'
    where id = profile_plan.id;
    perform public.refresh_bulk_rotation_plan_state(plan_row.id);
    return jsonb_build_object('chunkId', chunk_row.id, 'planId', plan_row.id,
      'status', 'suspended', 'generatedItems', '0', 'nextSlotIndex', chunk_row.next_slot_index::text);
  end if;

  range_start := chunk_row.next_slot_index;
  horizon_slot_exclusive := greatest(0, floor(
    extract(epoch from ((timezone('utc', now()) + interval '48 hours') - profile_plan.schedule_base_at))
      / 60 / plan_row.interval_minutes
  )::bigint);
  range_end := least(range_start + p_step_size::bigint,
    chunk_row.slot_start + chunk_row.slot_count, horizon_slot_exclusive);

  if range_start >= chunk_row.slot_start + chunk_row.slot_count then
    update public.bulk_publication_generation_chunks
    set status = 'completed', claimed_by = null, lease_until = null,
        completed_at = coalesce(completed_at, timezone('utc', now())), last_progress_at = timezone('utc', now())
    where id = chunk_row.id;
    update public.bulk_publication_plan_profiles
    set status = 'completed', next_slot_index = total_slot_count, generated_slot_count = total_slot_count
    where id = profile_plan.id;
    update public.bulk_publication_profile_horizons
    set status = 'completed', released_at = coalesce(released_at, timezone('utc', now()))
    where plan_profile_id = profile_plan.id and status = 'active';
    perform public.refresh_bulk_rotation_plan_state(plan_row.id);
    return jsonb_build_object('chunkId', chunk_row.id, 'planId', plan_row.id,
      'status', 'completed', 'generatedItems', '0', 'nextSlotIndex', range_start::text);
  end if;

  if range_start >= range_end then
    update public.bulk_publication_generation_chunks
    set status = 'queued', claimed_by = null, lease_until = null,
        attempt_count = greatest(attempt_count - 1, 0), last_error_message = null
    where id = chunk_row.id;
    return jsonb_build_object('chunkId', chunk_row.id, 'planId', plan_row.id,
      'status', 'horizon_waiting', 'processedItems', '0',
      'nextSlotIndex', range_start::text, 'horizonHours', 48);
  end if;

  with desired as (
    select slot.slot_index,
      concat('bulk:', plan_row.id, ':', profile_plan.profile_id, ':', slot.slot_index) as idempotency_key,
      profile_plan.schedule_base_at + ((((slot.slot_index + 1) * plan_row.interval_minutes::bigint)::text || ' minutes')::interval) as execute_at,
      media.media_asset_id
    from generate_series(range_start, range_end - 1) slot(slot_index)
    join public.bulk_publication_plan_media media on media.plan_id = plan_row.id
      and media.ordinal = mod(profile_plan.rotation_offset + slot.slot_index * profile_plan.rotation_step, plan_row.media_count)
  ), inserted as (
    insert into public.publication_items (
      organization_id, batch_id, profile_id, format, status, execute_at, caption,
      idempotency_key, reel_cover_media_asset_id
    )
    select plan_row.organization_id, plan_row.batch_id, profile_plan.profile_id,
      plan_row.format, 'waiting'::public.publication_item_status, desired.execute_at,
      plan_row.caption, desired.idempotency_key, plan_row.reel_cover_media_asset_id
    from desired
    where not exists (
      select 1 from public.publication_items existing
      where existing.organization_id = plan_row.organization_id
        and existing.idempotency_key = desired.idempotency_key
    )
    on conflict (organization_id, idempotency_key) do nothing
    returning id, idempotency_key
  ), inserted_media as (
    insert into public.publication_item_media (organization_id, publication_item_id, media_asset_id, position)
    select plan_row.organization_id, inserted.id, desired.media_asset_id, 0
    from inserted join desired using (idempotency_key)
    returning publication_item_id
  ), inserted_events as (
    insert into public.publication_item_events (
      organization_id, publication_item_id, event_type, previous_status, status,
      actor_user_id, actor_label, metadata
    )
    select plan_row.organization_id, inserted.id, 'queued', null, 'waiting',
      plan_row.created_by, trim(p_worker_id),
      jsonb_build_object('execute_at', desired.execute_at, 'bulk_plan_id', plan_row.id,
        'bulk_chunk_id', chunk_row.id, 'bulk_slot_index', desired.slot_index::text,
        'bulk_algorithm_version', plan_row.algorithm_version,
        'reel_cover_media_asset_id', plan_row.reel_cover_media_asset_id)
    from inserted join desired using (idempotency_key)
    returning publication_item_id
  ) select count(*)::bigint into inserted_count from inserted;

  select count(*)::bigint into materialized_count
  from generate_series(range_start, range_end - 1) slot(slot_index)
  join public.publication_items item
    on item.organization_id = plan_row.organization_id
   and item.idempotency_key = concat('bulk:', plan_row.id, ':', profile_plan.profile_id, ':', slot.slot_index)
   and item.batch_id = plan_row.batch_id and item.profile_id = profile_plan.profile_id
   and item.format = plan_row.format
   and item.execute_at = profile_plan.schedule_base_at + ((((slot.slot_index + 1) * plan_row.interval_minutes::bigint)::text || ' minutes')::interval)
   and item.caption is not distinct from plan_row.caption
   and item.reel_cover_media_asset_id is not distinct from plan_row.reel_cover_media_asset_id
  join public.bulk_publication_plan_media media
    on media.plan_id = plan_row.id
   and media.ordinal = mod(profile_plan.rotation_offset + slot.slot_index * profile_plan.rotation_step, plan_row.media_count)
  join public.publication_item_media link
    on link.publication_item_id = item.id and link.organization_id = item.organization_id
   and link.position = 0 and link.media_asset_id = media.media_asset_id;
  if materialized_count <> range_end - range_start then
    raise exception using errcode = '23505', message = 'Conflito de idempotência ao materializar chunk compacto.';
  end if;

  completed := range_end >= chunk_row.slot_start + chunk_row.slot_count;
  update public.bulk_publication_generation_chunks
  set next_slot_index = range_end, generated_items = range_end - chunk_row.slot_start,
      status = case when completed then 'completed' else 'queued' end,
      claimed_by = null, lease_until = null, consecutive_failure_count = 0,
      retry_exhausted_at = null, last_error_message = null,
      last_progress_at = timezone('utc', now()),
      completed_at = case when completed then timezone('utc', now()) else null end
  where id = chunk_row.id;
  update public.bulk_publication_plan_profiles
  set next_slot_index = range_end, generated_slot_count = range_end - chunk_row.slot_start,
      status = case when completed then 'completed' else 'generating' end
  where id = profile_plan.id;
  if completed then
    update public.bulk_publication_profile_horizons
    set status = 'completed', released_at = coalesce(released_at, timezone('utc', now()))
    where plan_profile_id = profile_plan.id and status = 'active';
  end if;
  perform public.refresh_bulk_rotation_plan_state(plan_row.id);
  return jsonb_build_object('chunkId', chunk_row.id, 'planId', plan_row.id,
    'status', case when completed then 'completed' else 'queued' end,
    'processedItems', (range_end - range_start)::text,
    'insertedItems', inserted_count::text,
    'idempotentItems', (range_end - range_start - inserted_count)::text,
    'nextSlotIndex', range_end::text, 'horizonHours', 48);
end;
$$;

revoke all on function public.process_bulk_rotation_generation_chunk(uuid,text,integer)
  from public, anon, authenticated;
grant execute on function public.process_bulk_rotation_generation_chunk(uuid,text,integer)
  to service_role;

notify pgrst, 'reload schema';
