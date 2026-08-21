-- Geração incremental dos planos compactos. O worker transporta apenas IDs e
-- contadores; slots, datas e rotação de mídia são resolvidos transacionalmente.

alter table public.bulk_publication_generation_chunks
  add column if not exists consecutive_failure_count integer not null default 0
    check (consecutive_failure_count >= 0),
  add column if not exists retry_exhausted_at timestamptz,
  add column if not exists last_progress_at timestamptz;

create index if not exists bulk_publication_chunks_incremental_claim_idx
  on public.bulk_publication_generation_chunks (status, retry_exhausted_at, lease_until, created_at, chunk_ordinal)
  where status in ('queued', 'processing', 'failed');

create or replace function public.refresh_bulk_rotation_plan_state(p_plan_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_status text;
  next_status text;
  generated_count bigint;
  suspended_count bigint;
  ignored_count bigint;
  failed_count bigint;
  active_chunks bigint;
  paused_chunks bigint;
  exhausted_chunks bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('bulk-plan-state:' || p_plan_id::text, 0));

  select plan.status into current_status
  from public.bulk_publication_plans plan
  where plan.id = p_plan_id
  for update;
  if current_status is null then return; end if;

  select
    coalesce(sum(profile_plan.generated_slot_count), 0)::bigint,
    coalesce(sum(case when profile_plan.status = 'suspended'
      then greatest(profile_plan.total_slot_count - profile_plan.generated_slot_count - profile_plan.ignored_slot_count, 0)
      else 0 end), 0)::bigint,
    coalesce(sum(profile_plan.ignored_slot_count), 0)::bigint,
    coalesce(sum(profile_plan.failed_slot_count), 0)::bigint
  into generated_count, suspended_count, ignored_count, failed_count
  from public.bulk_publication_plan_profiles profile_plan
  where profile_plan.plan_id = p_plan_id;

  select
    count(*) filter (where chunk.status in ('queued', 'processing')
      or (chunk.status = 'failed' and chunk.retry_exhausted_at is null)),
    count(*) filter (where chunk.status = 'paused'),
    count(*) filter (where chunk.status = 'failed' and chunk.retry_exhausted_at is not null)
  into active_chunks, paused_chunks, exhausted_chunks
  from public.bulk_publication_generation_chunks chunk
  where chunk.plan_id = p_plan_id;

  next_status := case
    when current_status = 'cancelled' then 'cancelled'
    when active_chunks > 0 then 'generating'
    when paused_chunks > 0 then 'paused'
    when exhausted_chunks > 0 or failed_count > 0 then 'completed_with_errors'
    else 'completed'
  end;

  update public.bulk_publication_plans plan
  set status = next_status,
      generated_publications = generated_count,
      suspended_publications = suspended_count,
      ignored_publications = ignored_count,
      failed_publications = failed_count,
      started_at = case when next_status <> 'queued' then coalesce(plan.started_at, timezone('utc', now())) else plan.started_at end,
      completed_at = case when next_status in ('completed', 'completed_with_errors')
        then coalesce(plan.completed_at, timezone('utc', now())) else null end
  where plan.id = p_plan_id;
end;
$$;

create or replace function public.claim_bulk_rotation_generation_chunks(
  p_worker_id text,
  p_limit integer default 1,
  p_lease_seconds integer default 300,
  p_max_failures integer default 3
)
returns table (
  id uuid,
  plan_id uuid,
  plan_profile_id uuid,
  organization_id uuid,
  profile_id uuid,
  status text,
  slot_start text,
  slot_count text,
  next_slot_index text,
  attempt_count integer,
  lease_until timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  affected_plan_id uuid;
  affected_plan_ids uuid[] := '{}'::uuid[];
begin
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido.';
  end if;
  if p_limit not between 1 and 50 then
    raise exception using errcode = '22023', message = 'Limite de claim deve estar entre 1 e 50.';
  end if;
  if p_lease_seconds not between 60 and 3600 then
    raise exception using errcode = '22023', message = 'Lease deve estar entre 60 e 3600 segundos.';
  end if;
  if p_max_failures not between 1 and 20 then
    raise exception using errcode = '22023', message = 'Limite de falhas deve estar entre 1 e 20.';
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
        suspension_reason = 'Perfil offline; retomada manual necessária.'
    where profile_plan.id in (select paused.plan_profile_id from paused_chunks paused)
    returning profile_plan.plan_id
  )
  select coalesce(array_agg(distinct suspended.plan_id), '{}'::uuid[])
  into affected_plan_ids
  from suspended_profiles suspended;

  foreach affected_plan_id in array affected_plan_ids
  loop
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
    order by plan.created_at, plan.id, profile_plan.ordinal, chunk.chunk_ordinal, chunk.id
    for update of chunk skip locked
    limit p_limit
  ), claimed as (
    update public.bulk_publication_generation_chunks chunk
    set status = 'processing', claimed_by = trim(p_worker_id),
        lease_until = timezone('utc', now()) + make_interval(secs => p_lease_seconds),
        attempt_count = chunk.attempt_count + 1, last_error_message = null
    from candidates
    where chunk.id = candidates.id
    returning chunk.*
  ), activated_profiles as (
    update public.bulk_publication_plan_profiles profile_plan
    set status = 'generating'
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

create or replace function public.process_bulk_rotation_generation_chunk(
  p_chunk_id uuid,
  p_worker_id text,
  p_step_size integer default 500
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  chunk_row public.bulk_publication_generation_chunks%rowtype;
  profile_plan public.bulk_publication_plan_profiles%rowtype;
  plan_row public.bulk_publication_plans%rowtype;
  range_start bigint;
  range_end bigint;
  inserted_count bigint := 0;
  materialized_count bigint := 0;
  completed boolean;
begin
  if p_step_size not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'Passo deve estar entre 1 e 1.000 slots.';
  end if;

  select * into chunk_row
  from public.bulk_publication_generation_chunks chunk
  where chunk.id = p_chunk_id and chunk.claimed_by = trim(p_worker_id) and chunk.status = 'processing'
  for update;
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
    return jsonb_build_object('chunkId', chunk_row.id, 'planId', plan_row.id, 'status', 'suspended',
      'generatedItems', '0', 'nextSlotIndex', chunk_row.next_slot_index::text);
  end if;

  range_start := chunk_row.next_slot_index;
  range_end := least(range_start + p_step_size::bigint, chunk_row.slot_start + chunk_row.slot_count);
  if range_start >= range_end then
    update public.bulk_publication_generation_chunks
    set status = 'completed', claimed_by = null, lease_until = null,
        completed_at = coalesce(completed_at, timezone('utc', now())), last_progress_at = timezone('utc', now())
    where id = chunk_row.id;
    update public.bulk_publication_plan_profiles
    set status = 'completed', next_slot_index = total_slot_count,
        generated_slot_count = total_slot_count
    where id = profile_plan.id;
    update public.bulk_publication_profile_horizons
    set status = 'completed', released_at = coalesce(released_at, timezone('utc', now()))
    where plan_profile_id = profile_plan.id and status = 'active';
    perform public.refresh_bulk_rotation_plan_state(plan_row.id);
    return jsonb_build_object('chunkId', chunk_row.id, 'planId', plan_row.id, 'status', 'completed',
      'generatedItems', '0', 'nextSlotIndex', range_end::text);
  end if;

  with desired as (
    select slot.slot_index,
      concat('bulk:', plan_row.id, ':', profile_plan.profile_id, ':', slot.slot_index) as idempotency_key,
      profile_plan.schedule_base_at
        + ((((slot.slot_index + 1) * plan_row.interval_minutes::bigint)::text || ' minutes')::interval) as execute_at,
      media.media_asset_id
    from generate_series(range_start, range_end - 1) as slot(slot_index)
    join public.bulk_publication_plan_media media
      on media.plan_id = plan_row.id
      and media.ordinal = mod(profile_plan.rotation_offset + slot.slot_index, plan_row.media_count)
  ), inserted as (
    insert into public.publication_items (
      organization_id, batch_id, profile_id, format, status, execute_at, caption, idempotency_key
    )
    select plan_row.organization_id, plan_row.batch_id, profile_plan.profile_id, plan_row.format,
      'waiting'::public.publication_item_status, desired.execute_at, plan_row.caption, desired.idempotency_key
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
        'bulk_chunk_id', chunk_row.id, 'bulk_slot_index', desired.slot_index::text)
    from inserted join desired using (idempotency_key)
    returning publication_item_id
  )
  select count(*)::bigint into inserted_count from inserted;

  select count(*)::bigint into materialized_count
  from generate_series(range_start, range_end - 1) as slot(slot_index)
  join public.publication_items item
    on item.organization_id = plan_row.organization_id
    and item.idempotency_key = concat('bulk:', plan_row.id, ':', profile_plan.profile_id, ':', slot.slot_index)
    and item.batch_id = plan_row.batch_id and item.profile_id = profile_plan.profile_id
    and item.format = plan_row.format
    and item.execute_at = profile_plan.schedule_base_at
      + ((((slot.slot_index + 1) * plan_row.interval_minutes::bigint)::text || ' minutes')::interval)
    and item.caption is not distinct from plan_row.caption
  join public.bulk_publication_plan_media media
    on media.plan_id = plan_row.id
    and media.ordinal = mod(profile_plan.rotation_offset + slot.slot_index, plan_row.media_count)
  join public.publication_item_media link
    on link.publication_item_id = item.id and link.organization_id = item.organization_id
    and link.position = 0 and link.media_asset_id = media.media_asset_id;

  if materialized_count <> range_end - range_start then
    raise exception using errcode = '23505', message = 'Conflito de idempotência ao materializar chunk compacto.';
  end if;

  completed := range_end >= chunk_row.slot_start + chunk_row.slot_count;
  update public.bulk_publication_generation_chunks
  set next_slot_index = range_end,
      generated_items = range_end - chunk_row.slot_start,
      status = case when completed then 'completed' else 'queued' end,
      claimed_by = null, lease_until = null, consecutive_failure_count = 0,
      retry_exhausted_at = null, last_error_message = null,
      last_progress_at = timezone('utc', now()),
      completed_at = case when completed then timezone('utc', now()) else null end
  where id = chunk_row.id;

  update public.bulk_publication_plan_profiles
  set next_slot_index = range_end,
      generated_slot_count = range_end - chunk_row.slot_start,
      status = case when completed then 'completed' else 'generating' end
  where id = profile_plan.id;

  if completed then
    update public.bulk_publication_profile_horizons
    set status = 'completed', released_at = coalesce(released_at, timezone('utc', now()))
    where plan_profile_id = profile_plan.id and status = 'active';
  end if;

  perform public.refresh_bulk_rotation_plan_state(plan_row.id);
  return jsonb_build_object(
    'chunkId', chunk_row.id, 'planId', plan_row.id,
    'status', case when completed then 'completed' else 'queued' end,
    'processedItems', (range_end - range_start)::text,
    'insertedItems', inserted_count::text,
    'idempotentItems', (range_end - range_start - inserted_count)::text,
    'nextSlotIndex', range_end::text
  );
end;
$$;

create or replace function public.fail_bulk_rotation_generation_chunk(
  p_chunk_id uuid,
  p_worker_id text,
  p_error_message text,
  p_max_failures integer default 3
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  chunk_row public.bulk_publication_generation_chunks%rowtype;
  next_failure_count integer;
  exhausted boolean;
  remaining bigint;
begin
  if p_max_failures not between 1 and 20 then
    raise exception using errcode = '22023', message = 'Limite de falhas deve estar entre 1 e 20.';
  end if;
  select * into chunk_row from public.bulk_publication_generation_chunks chunk
  where chunk.id = p_chunk_id and chunk.claimed_by = trim(p_worker_id) and chunk.status = 'processing'
  for update;
  if chunk_row.id is null then
    raise exception using errcode = 'P0002', message = 'Chunk compacto não encontrado ou pertence a outro worker.';
  end if;

  next_failure_count := chunk_row.consecutive_failure_count + 1;
  exhausted := next_failure_count >= p_max_failures;
  remaining := greatest(chunk_row.slot_start + chunk_row.slot_count - chunk_row.next_slot_index, 0);
  update public.bulk_publication_generation_chunks
  set status = 'failed', claimed_by = null, lease_until = null,
      consecutive_failure_count = next_failure_count,
      retry_exhausted_at = case when exhausted then timezone('utc', now()) else null end,
      failed_items = case when exhausted then remaining else failed_items end,
      last_error_message = left(coalesce(nullif(trim(p_error_message), ''), 'Falha desconhecida.'), 1200)
  where id = chunk_row.id;

  if exhausted then
    update public.bulk_publication_plan_profiles
    set status = 'failed', failed_slot_count = remaining
    where id = chunk_row.plan_profile_id;
    update public.bulk_publication_profile_horizons
    set status = 'cancelled', released_at = coalesce(released_at, timezone('utc', now()))
    where plan_profile_id = chunk_row.plan_profile_id and status = 'active';
  end if;

  perform public.refresh_bulk_rotation_plan_state(chunk_row.plan_id);
  return jsonb_build_object('chunkId', chunk_row.id, 'planId', chunk_row.plan_id,
    'status', 'failed', 'consecutiveFailures', next_failure_count,
    'retryExhausted', exhausted, 'remainingItems', remaining::text);
end;
$$;

create or replace function public.get_bulk_rotation_worker_summary()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'activePlans', count(*) filter (where plan.status in ('queued', 'generating', 'paused'))::bigint::text,
    'queuedPlans', count(*) filter (where plan.status = 'queued')::bigint::text,
    'generatingPlans', count(*) filter (where plan.status = 'generating')::bigint::text,
    'pausedPlans', count(*) filter (where plan.status = 'paused')::bigint::text,
    'expectedPublications', coalesce(sum(plan.expected_publications)
      filter (where plan.status in ('queued', 'generating', 'paused')), 0)::bigint::text,
    'generatedPublications', coalesce(sum(plan.generated_publications)
      filter (where plan.status in ('queued', 'generating', 'paused')), 0)::bigint::text,
    'remainingPublications', coalesce(sum(greatest(plan.expected_publications - plan.generated_publications
      - plan.ignored_publications - plan.failed_publications, 0))
      filter (where plan.status in ('queued', 'generating', 'paused')), 0)::bigint::text,
    'claimableChunks', (select count(*)::bigint::text from public.bulk_publication_generation_chunks chunk
      join public.bulk_publication_plans chunk_plan on chunk_plan.id = chunk.plan_id
      where chunk_plan.status in ('queued', 'generating')
        and chunk.status in ('queued', 'processing', 'failed') and chunk.retry_exhausted_at is null
        and (chunk.lease_until is null or chunk.lease_until <= timezone('utc', now()))),
    'processingChunks', (select count(*)::bigint::text from public.bulk_publication_generation_chunks chunk
      where chunk.status = 'processing' and chunk.lease_until > timezone('utc', now())),
    'pausedChunks', (select count(*)::bigint::text from public.bulk_publication_generation_chunks chunk
      where chunk.status = 'paused'),
    'exhaustedChunks', (select count(*)::bigint::text from public.bulk_publication_generation_chunks chunk
      where chunk.status = 'failed' and chunk.retry_exhausted_at is not null)
  )
  from public.bulk_publication_plans plan;
$$;

-- Uma reserva compacta impede que novos agendamentos tradicionais ocupem o
-- horizonte ainda não materializado. Itens anteriores à reserva permanecem válidos.
create or replace function public.enforce_active_publication_slot_uniqueness()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.execute_at is not null
    and new.status in ('waiting', 'ready', 'preparing', 'publishing')
    and exists (
      select 1 from public.publication_items occupied
      where occupied.organization_id = new.organization_id and occupied.profile_id = new.profile_id
        and occupied.format = new.format and occupied.execute_at = new.execute_at
        and occupied.status in ('waiting', 'ready', 'preparing', 'publishing') and occupied.id <> new.id
    ) then
    raise exception using errcode = '23505', message = 'active_publication_slot_conflict';
  end if;

  if tg_op = 'INSERT' and new.execute_at is not null
    and new.status in ('waiting', 'ready', 'preparing', 'publishing')
    and exists (
      select 1
      from public.bulk_publication_profile_horizons horizon
      join public.bulk_publication_plans plan on plan.id = horizon.plan_id
      where horizon.organization_id = new.organization_id and horizon.profile_id = new.profile_id
        and horizon.status = 'active' and new.execute_at >= horizon.first_execute_at
        and new.execute_at <= horizon.reserved_through and new.batch_id <> plan.batch_id
        and new.created_at >= horizon.created_at
    ) then
    raise exception using errcode = '23505', message = 'bulk_publication_horizon_conflict';
  end if;
  return new;
end;
$$;

create or replace function public.media_asset_is_in_active_generation_job(
  p_organization_id uuid,
  p_media_asset_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.publication_generation_jobs job
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(job.payload -> 'items') = 'array' then job.payload -> 'items' else '[]'::jsonb end
    ) payload_item(item)
    where job.organization_id = p_organization_id and job.status in ('queued', 'processing', 'paused')
      and jsonb_typeof(payload_item.item -> 'mediaIds') = 'array'
      and exists (select 1 from jsonb_array_elements_text(payload_item.item -> 'mediaIds') media_value(id)
        where media_value.id = p_media_asset_id::text)
  ) or exists (
    select 1
    from public.publication_generation_job_chunks chunk
    join public.publication_generation_jobs job on job.id = chunk.job_id
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(chunk.payload) = 'array' then chunk.payload else '[]'::jsonb end
    ) payload_item(item)
    where chunk.organization_id = p_organization_id and job.organization_id = p_organization_id
      and job.status in ('queued', 'processing', 'paused') and chunk.status in ('queued', 'processing', 'failed')
      and jsonb_typeof(payload_item.item -> 'mediaIds') = 'array'
      and exists (select 1 from jsonb_array_elements_text(payload_item.item -> 'mediaIds') media_value(id)
        where media_value.id = p_media_asset_id::text)
  ) or exists (
    select 1
    from public.bulk_publication_plan_media plan_media
    join public.bulk_publication_plans plan on plan.id = plan_media.plan_id
    where plan_media.organization_id = p_organization_id and plan_media.media_asset_id = p_media_asset_id
      and plan.status in ('queued', 'generating', 'paused')
  );
$$;

revoke all on function public.refresh_bulk_rotation_plan_state(uuid) from public, anon, authenticated;
revoke all on function public.claim_bulk_rotation_generation_chunks(text, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.process_bulk_rotation_generation_chunk(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.fail_bulk_rotation_generation_chunk(uuid, text, text, integer) from public, anon, authenticated;
revoke all on function public.get_bulk_rotation_worker_summary() from public, anon, authenticated;
revoke all on function public.enforce_active_publication_slot_uniqueness() from public;
revoke all on function public.media_asset_is_in_active_generation_job(uuid, uuid) from public, anon;

grant execute on function public.claim_bulk_rotation_generation_chunks(text, integer, integer, integer) to service_role;
grant execute on function public.process_bulk_rotation_generation_chunk(uuid, text, integer) to service_role;
grant execute on function public.fail_bulk_rotation_generation_chunk(uuid, text, text, integer) to service_role;
grant execute on function public.get_bulk_rotation_worker_summary() to service_role;
grant execute on function public.media_asset_is_in_active_generation_job(uuid, uuid) to service_role;
