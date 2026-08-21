-- Diversificação forte para novos planos compactos, preservando integralmente a
-- materialização dos planos v1 já existentes.

alter table public.bulk_publication_plans
  drop constraint if exists bulk_publication_plans_algorithm_version_check;
alter table public.bulk_publication_plans
  add constraint bulk_publication_plans_algorithm_version_check
  check (algorithm_version in (1, 2));

alter table public.bulk_publication_plan_profiles
  add column if not exists rotation_step bigint not null default 1;
alter table public.bulk_publication_plan_profiles
  drop constraint if exists bulk_publication_plan_profiles_rotation_step_check;
alter table public.bulk_publication_plan_profiles
  add constraint bulk_publication_plan_profiles_rotation_step_check check (rotation_step > 0);

create or replace function public.bulk_rotation_v2_profile_offset(
  p_seed text,
  p_profile_ordinal bigint,
  p_media_count bigint
)
returns bigint
language sql
immutable
strict
parallel safe
set search_path = public
as $$
  select case when p_media_count <= 1 then 0 else
    mod(
      hashtextextended(p_seed, 0)::numeric + 9223372036854775808::numeric + p_profile_ordinal::numeric,
      p_media_count::numeric
    )::bigint
  end;
$$;

create or replace function public.bulk_rotation_v2_profile_step(
  p_seed text,
  p_profile_ordinal bigint,
  p_media_count bigint
)
returns bigint
language sql
immutable
strict
parallel safe
set search_path = public
as $$
  with candidates as (
    select candidate::bigint as value,
      row_number() over (order by candidate) - 1 as index,
      count(*) over () as candidate_count
    from generate_series(1::bigint, greatest(p_media_count - 1, 0)) candidate
    where gcd(candidate, p_media_count) = 1
  ), selected as (
    select value
    from candidates
    where index = mod(
      hashtextextended(p_seed || ':step', 0)::numeric
        + 9223372036854775808::numeric + p_profile_ordinal::numeric,
      candidate_count::numeric
    )::bigint
  )
  select case when p_media_count <= 1 then 1 else (select value from selected) end;
$$;

create or replace function public.create_bulk_rotation_plan_v2(
  p_organization_id uuid,
  p_request_key text,
  p_name text,
  p_profile_ids uuid[],
  p_origin_type text,
  p_origin_group_id uuid,
  p_format public.publication_format,
  p_interval_minutes integer,
  p_duration_days bigint,
  p_caption text,
  p_order_mode text,
  p_rotation_seed text,
  p_algorithm_version smallint default 2,
  p_chunk_size integer default 500,
  p_now timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  created jsonb;
  resolved_plan_id uuid;
begin
  if p_algorithm_version <> 2 then
    raise exception using errcode = '22023', message = 'A criação v2 exige a versão 2 do algoritmo.';
  end if;

  -- A função v1 continua sendo a autoridade para validação, idempotência,
  -- reserva de horizonte e criação atômica. O plano só fica visível após esta
  -- transação, portanto o worker nunca observa o estado intermediário v1.
  created := public.create_bulk_rotation_plan(
    p_organization_id, p_request_key, p_name, p_profile_ids, p_origin_type,
    p_origin_group_id, p_format, p_interval_minutes, p_duration_days, p_caption,
    p_order_mode, p_rotation_seed, 1::smallint, p_chunk_size, p_now
  );
  resolved_plan_id := (created ->> 'planId')::uuid;

  if coalesce((created ->> 'created')::boolean, false) then
    update public.bulk_publication_plans
    set algorithm_version = 2
    where id = resolved_plan_id and algorithm_version = 1;

    update public.bulk_publication_plan_profiles profile_plan
    set rotation_offset = case
          when p_order_mode = 'same_order' then 0
          else public.bulk_rotation_v2_profile_offset(p_rotation_seed, profile_plan.ordinal, plan_row.media_count)
        end,
        rotation_step = case
          when p_order_mode = 'same_order' then 1
          else public.bulk_rotation_v2_profile_step(p_rotation_seed, profile_plan.ordinal, plan_row.media_count)
        end
    from public.bulk_publication_plans plan_row
    where profile_plan.plan_id = resolved_plan_id and plan_row.id = profile_plan.plan_id;
  elsif not exists (
    select 1 from public.bulk_publication_plans
    where id = resolved_plan_id and algorithm_version = 2
  ) then
    raise exception using errcode = '23505', message = 'Chave de idempotência pertence a um plano legado e não pode ser promovida.';
  end if;

  return created || jsonb_build_object('algorithmVersion', 2);
end;
$$;

create or replace function public.create_bulk_daily_rotation_plan_v2(
  p_organization_id uuid,
  p_request_key text,
  p_name text,
  p_profile_ids uuid[],
  p_origin_type text,
  p_origin_group_id uuid,
  p_format public.publication_format,
  p_repeat_days bigint,
  p_daily_time time,
  p_caption text,
  p_order_mode text,
  p_rotation_seed text,
  p_algorithm_version smallint default 2,
  p_chunk_size integer default 500,
  p_now timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  created jsonb;
  resolved_plan_id uuid;
begin
  if p_algorithm_version <> 2 then
    raise exception using errcode = '22023', message = 'A criação v2 exige a versão 2 do algoritmo.';
  end if;

  created := public.create_bulk_daily_rotation_plan(
    p_organization_id, p_request_key, p_name, p_profile_ids, p_origin_type,
    p_origin_group_id, p_format, p_repeat_days, p_daily_time, p_caption,
    p_order_mode, p_rotation_seed, 1::smallint, p_chunk_size, p_now
  );
  resolved_plan_id := (created ->> 'planId')::uuid;

  if coalesce((created ->> 'created')::boolean, false) then
    update public.bulk_publication_plans
    set algorithm_version = 2
    where id = resolved_plan_id and algorithm_version = 1;

    update public.bulk_publication_plan_profiles profile_plan
    set rotation_offset = case
          when p_order_mode = 'same_order' then 0
          else public.bulk_rotation_v2_profile_offset(p_rotation_seed, profile_plan.ordinal, plan_row.media_count)
        end,
        rotation_step = case
          when p_order_mode = 'same_order' then 1
          else public.bulk_rotation_v2_profile_step(p_rotation_seed, profile_plan.ordinal, plan_row.media_count)
        end
    from public.bulk_publication_plans plan_row
    where profile_plan.plan_id = resolved_plan_id and plan_row.id = profile_plan.plan_id;
  elsif not exists (
    select 1 from public.bulk_publication_plans
    where id = resolved_plan_id and algorithm_version = 2
  ) then
    raise exception using errcode = '23505', message = 'Chave de idempotência pertence a um plano legado e não pode ser promovida.';
  end if;

  return created || jsonb_build_object('algorithmVersion', 2);
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
  if p_step_size not between 1 and 1000 then raise exception using errcode = '22023', message = 'Passo deve estar entre 1 e 1.000 slots.'; end if;
  select * into chunk_row from public.bulk_publication_generation_chunks chunk where chunk.id = p_chunk_id and chunk.claimed_by = trim(p_worker_id) and chunk.status = 'processing' for update;
  if chunk_row.id is null then raise exception using errcode = 'P0002', message = 'Chunk compacto não encontrado ou pertence a outro worker.'; end if;
  select * into profile_plan from public.bulk_publication_plan_profiles where id = chunk_row.plan_profile_id for update;
  select * into plan_row from public.bulk_publication_plans where id = chunk_row.plan_id;
  if profile_plan.id is null or plan_row.id is null or plan_row.status not in ('queued', 'generating') then raise exception using errcode = 'P0002', message = 'Plano compacto não está disponível para geração.'; end if;

  if not exists (select 1 from public.instagram_profiles profile where profile.id = chunk_row.profile_id and profile.organization_id = chunk_row.organization_id and profile.deleted_at is null and profile.status = 'online') then
    update public.bulk_publication_generation_chunks set status = 'paused', claimed_by = null, lease_until = null, attempt_count = greatest(attempt_count - 1, 0), last_error_message = 'Perfil offline; geração suspensa sem consumir retry.' where id = chunk_row.id;
    update public.bulk_publication_plan_profiles set status = 'suspended', suspended_at = coalesce(suspended_at, timezone('utc', now())), suspension_reason = 'Perfil offline; retomada manual necessária.' where id = profile_plan.id;
    perform public.refresh_bulk_rotation_plan_state(plan_row.id);
    return jsonb_build_object('chunkId', chunk_row.id, 'planId', plan_row.id, 'status', 'suspended', 'generatedItems', '0', 'nextSlotIndex', chunk_row.next_slot_index::text);
  end if;

  range_start := chunk_row.next_slot_index;
  range_end := least(range_start + p_step_size::bigint, chunk_row.slot_start + chunk_row.slot_count);
  if range_start >= range_end then
    update public.bulk_publication_generation_chunks set status = 'completed', claimed_by = null, lease_until = null, completed_at = coalesce(completed_at, timezone('utc', now())), last_progress_at = timezone('utc', now()) where id = chunk_row.id;
    update public.bulk_publication_plan_profiles set status = 'completed', next_slot_index = total_slot_count, generated_slot_count = total_slot_count where id = profile_plan.id;
    update public.bulk_publication_profile_horizons set status = 'completed', released_at = coalesce(released_at, timezone('utc', now())) where plan_profile_id = profile_plan.id and status = 'active';
    perform public.refresh_bulk_rotation_plan_state(plan_row.id);
    return jsonb_build_object('chunkId', chunk_row.id, 'planId', plan_row.id, 'status', 'completed', 'generatedItems', '0', 'nextSlotIndex', range_end::text);
  end if;

  with desired as (
    select slot.slot_index,
      concat('bulk:', plan_row.id, ':', profile_plan.profile_id, ':', slot.slot_index) as idempotency_key,
      profile_plan.schedule_base_at + ((((slot.slot_index + 1) * plan_row.interval_minutes::bigint)::text || ' minutes')::interval) as execute_at,
      media.media_asset_id
    from generate_series(range_start, range_end - 1) as slot(slot_index)
    join public.bulk_publication_plan_media media on media.plan_id = plan_row.id
      and media.ordinal = mod(profile_plan.rotation_offset + slot.slot_index * profile_plan.rotation_step, plan_row.media_count)
  ), inserted as (
    insert into public.publication_items (organization_id, batch_id, profile_id, format, status, execute_at, caption, idempotency_key)
    select plan_row.organization_id, plan_row.batch_id, profile_plan.profile_id, plan_row.format, 'waiting'::public.publication_item_status, desired.execute_at, plan_row.caption, desired.idempotency_key
    from desired where not exists (select 1 from public.publication_items existing where existing.organization_id = plan_row.organization_id and existing.idempotency_key = desired.idempotency_key)
    on conflict (organization_id, idempotency_key) do nothing returning id, idempotency_key
  ), inserted_media as (
    insert into public.publication_item_media (organization_id, publication_item_id, media_asset_id, position)
    select plan_row.organization_id, inserted.id, desired.media_asset_id, 0 from inserted join desired using (idempotency_key) returning publication_item_id
  ), inserted_events as (
    insert into public.publication_item_events (organization_id, publication_item_id, event_type, previous_status, status, actor_user_id, actor_label, metadata)
    select plan_row.organization_id, inserted.id, 'queued', null, 'waiting', plan_row.created_by, trim(p_worker_id), jsonb_build_object('execute_at', desired.execute_at, 'bulk_plan_id', plan_row.id, 'bulk_chunk_id', chunk_row.id, 'bulk_slot_index', desired.slot_index::text, 'bulk_algorithm_version', plan_row.algorithm_version)
    from inserted join desired using (idempotency_key) returning publication_item_id
  ) select count(*)::bigint into inserted_count from inserted;

  select count(*)::bigint into materialized_count
  from generate_series(range_start, range_end - 1) as slot(slot_index)
  join public.publication_items item on item.organization_id = plan_row.organization_id and item.idempotency_key = concat('bulk:', plan_row.id, ':', profile_plan.profile_id, ':', slot.slot_index) and item.batch_id = plan_row.batch_id and item.profile_id = profile_plan.profile_id and item.format = plan_row.format and item.execute_at = profile_plan.schedule_base_at + ((((slot.slot_index + 1) * plan_row.interval_minutes::bigint)::text || ' minutes')::interval) and item.caption is not distinct from plan_row.caption
  join public.bulk_publication_plan_media media on media.plan_id = plan_row.id and media.ordinal = mod(profile_plan.rotation_offset + slot.slot_index * profile_plan.rotation_step, plan_row.media_count)
  join public.publication_item_media link on link.publication_item_id = item.id and link.organization_id = item.organization_id and link.position = 0 and link.media_asset_id = media.media_asset_id;
  if materialized_count <> range_end - range_start then raise exception using errcode = '23505', message = 'Conflito de idempotência ao materializar chunk compacto.'; end if;

  completed := range_end >= chunk_row.slot_start + chunk_row.slot_count;
  update public.bulk_publication_generation_chunks set next_slot_index = range_end, generated_items = range_end - chunk_row.slot_start, status = case when completed then 'completed' else 'queued' end, claimed_by = null, lease_until = null, consecutive_failure_count = 0, retry_exhausted_at = null, last_error_message = null, last_progress_at = timezone('utc', now()), completed_at = case when completed then timezone('utc', now()) else null end where id = chunk_row.id;
  update public.bulk_publication_plan_profiles set next_slot_index = range_end, generated_slot_count = range_end - chunk_row.slot_start, status = case when completed then 'completed' else 'generating' end where id = profile_plan.id;
  if completed then update public.bulk_publication_profile_horizons set status = 'completed', released_at = coalesce(released_at, timezone('utc', now())) where plan_profile_id = profile_plan.id and status = 'active'; end if;
  perform public.refresh_bulk_rotation_plan_state(plan_row.id);
  return jsonb_build_object('chunkId', chunk_row.id, 'planId', plan_row.id, 'status', case when completed then 'completed' else 'queued' end, 'processedItems', (range_end - range_start)::text, 'insertedItems', inserted_count::text, 'idempotentItems', (range_end - range_start - inserted_count)::text, 'nextSlotIndex', range_end::text);
end;
$$;

revoke all on function public.bulk_rotation_v2_profile_offset(text, bigint, bigint) from public, anon, authenticated;
revoke all on function public.bulk_rotation_v2_profile_step(text, bigint, bigint) from public, anon, authenticated;
revoke all on function public.create_bulk_rotation_plan_v2(uuid, text, text, uuid[], text, uuid, public.publication_format, integer, bigint, text, text, text, smallint, integer, timestamptz) from public, anon;
revoke all on function public.create_bulk_daily_rotation_plan_v2(uuid, text, text, uuid[], text, uuid, public.publication_format, bigint, time, text, text, text, smallint, integer, timestamptz) from public, anon;
grant execute on function public.create_bulk_rotation_plan_v2(uuid, text, text, uuid[], text, uuid, public.publication_format, integer, bigint, text, text, text, smallint, integer, timestamptz) to authenticated, service_role;
grant execute on function public.create_bulk_daily_rotation_plan_v2(uuid, text, text, uuid[], text, uuid, public.publication_format, bigint, time, text, text, text, smallint, integer, timestamptz) to authenticated, service_role;

notify pgrst, 'reload schema';
