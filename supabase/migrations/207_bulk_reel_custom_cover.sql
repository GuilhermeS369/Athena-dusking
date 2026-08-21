-- Capa editorial opcional para Reels criados pela programação em massa.
-- A referência é persistida no plano e copiada para cada item materializado;
-- o arquivo continua único no Storage e a URL pública permanece temporária.

alter table public.bulk_publication_plans
  add column if not exists reel_cover_media_asset_id uuid
    references public.media_assets (id) on delete restrict;

alter table public.publication_items
  add column if not exists reel_cover_media_asset_id uuid
    references public.media_assets (id) on delete restrict;

alter table public.bulk_publication_plans
  drop constraint if exists bulk_publication_plans_reel_cover_format_check;
alter table public.bulk_publication_plans
  add constraint bulk_publication_plans_reel_cover_format_check
  check (reel_cover_media_asset_id is null or format = 'reel');

alter table public.publication_items
  drop constraint if exists publication_items_reel_cover_format_check;
alter table public.publication_items
  add constraint publication_items_reel_cover_format_check
  check (reel_cover_media_asset_id is null or format = 'reel');

create index if not exists bulk_publication_plans_active_reel_cover_idx
  on public.bulk_publication_plans (organization_id, reel_cover_media_asset_id)
  where reel_cover_media_asset_id is not null and status in ('queued', 'generating', 'paused');

create index if not exists publication_items_active_reel_cover_idx
  on public.publication_items (organization_id, reel_cover_media_asset_id)
  where reel_cover_media_asset_id is not null
    and status in ('draft', 'waiting', 'preparing', 'ready', 'publishing', 'failed', 'suspended');

create or replace function public.validate_publication_reel_cover()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.reel_cover_media_asset_id is null then return new; end if;
  if new.format <> 'reel' then
    raise exception using errcode = '23514', message = 'Capa personalizada só pode ser usada em Reel.';
  end if;
  if not exists (
    select 1 from public.media_assets asset
    where asset.id = new.reel_cover_media_asset_id
      and asset.organization_id = new.organization_id
      and asset.kind = 'image'
  ) then
    raise exception using errcode = '23514', message = 'A capa precisa ser uma imagem da mesma organização.';
  end if;
  return new;
end;
$$;

drop trigger if exists bulk_publication_plans_validate_reel_cover on public.bulk_publication_plans;
create trigger bulk_publication_plans_validate_reel_cover
before insert or update of reel_cover_media_asset_id, organization_id, format on public.bulk_publication_plans
for each row execute function public.validate_publication_reel_cover();

drop trigger if exists publication_items_validate_reel_cover on public.publication_items;
create trigger publication_items_validate_reel_cover
before insert or update of reel_cover_media_asset_id, organization_id, format on public.publication_items
for each row execute function public.validate_publication_reel_cover();

create or replace function public.bulk_reel_cover_is_eligible(
  p_organization_id uuid,
  p_media_asset_id uuid,
  p_origin_type text,
  p_origin_group_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_media_asset_id is not null
    and p_origin_type in ('group', 'ungrouped')
    and ((p_origin_type = 'group' and p_origin_group_id is not null)
      or (p_origin_type = 'ungrouped' and p_origin_group_id is null))
    and exists (
      select 1 from public.media_assets asset
      where asset.id = p_media_asset_id
        and asset.organization_id = p_organization_id
        and asset.kind = 'image'
        and asset.status = 'ready'
        and asset.deleted_at is null
        and asset.deletion_requested_at is null
        and public.media_asset_has_storage_object(asset.storage_path)
        and (
          (p_origin_type = 'group' and exists (
            select 1 from public.media_group_assignments assignment
            where assignment.organization_id = p_organization_id
              and assignment.group_id = p_origin_group_id
              and assignment.media_asset_id = asset.id
          ))
          or (p_origin_type = 'ungrouped' and not exists (
            select 1 from public.media_group_assignments assignment
            where assignment.organization_id = p_organization_id
              and assignment.media_asset_id = asset.id
          ))
        )
    );
$$;

-- Sobrecargas com capa. As assinaturas anteriores são mantidas para clientes
-- antigos; novos clientes sempre informam os três argumentos de capa.
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
  p_reel_cover_media_asset_id uuid,
  p_reel_cover_origin_type text,
  p_reel_cover_origin_group_id uuid,
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
  existing_cover uuid;
begin
  if p_reel_cover_media_asset_id is not null and p_format <> 'reel' then
    raise exception using errcode = '22023', message = 'Capa personalizada só pode ser usada em Reel.';
  end if;
  if p_reel_cover_media_asset_id is not null and not public.bulk_reel_cover_is_eligible(
    p_organization_id, p_reel_cover_media_asset_id, p_reel_cover_origin_type, p_reel_cover_origin_group_id
  ) then
    raise exception using errcode = '22023', message = 'A imagem de capa não está disponível na origem selecionada.';
  end if;
  if p_reel_cover_media_asset_id is null
    and (p_reel_cover_origin_type is not null or p_reel_cover_origin_group_id is not null) then
    raise exception using errcode = '22023', message = 'Configuração de capa inconsistente.';
  end if;

  created := public.create_bulk_rotation_plan_v2(
    p_organization_id, p_request_key, p_name, p_profile_ids, p_origin_type,
    p_origin_group_id, p_format, p_interval_minutes, p_duration_days, p_caption,
    p_order_mode, p_rotation_seed, p_algorithm_version, p_chunk_size, p_now
  );
  resolved_plan_id := (created ->> 'planId')::uuid;
  select reel_cover_media_asset_id into existing_cover
  from public.bulk_publication_plans where id = resolved_plan_id for update;

  if coalesce((created ->> 'created')::boolean, false) then
    update public.bulk_publication_plans
    set reel_cover_media_asset_id = p_reel_cover_media_asset_id
    where id = resolved_plan_id;
  elsif existing_cover is distinct from p_reel_cover_media_asset_id then
    raise exception using errcode = '23505', message = 'Chave de idempotência já usada com outra capa.';
  end if;
  return created || jsonb_build_object('reelCoverMediaAssetId', p_reel_cover_media_asset_id);
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
  p_reel_cover_media_asset_id uuid,
  p_reel_cover_origin_type text,
  p_reel_cover_origin_group_id uuid,
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
  existing_cover uuid;
begin
  if p_reel_cover_media_asset_id is not null and p_format <> 'reel' then
    raise exception using errcode = '22023', message = 'Capa personalizada só pode ser usada em Reel.';
  end if;
  if p_reel_cover_media_asset_id is not null and not public.bulk_reel_cover_is_eligible(
    p_organization_id, p_reel_cover_media_asset_id, p_reel_cover_origin_type, p_reel_cover_origin_group_id
  ) then
    raise exception using errcode = '22023', message = 'A imagem de capa não está disponível na origem selecionada.';
  end if;
  if p_reel_cover_media_asset_id is null
    and (p_reel_cover_origin_type is not null or p_reel_cover_origin_group_id is not null) then
    raise exception using errcode = '22023', message = 'Configuração de capa inconsistente.';
  end if;

  created := public.create_bulk_daily_rotation_plan_v2(
    p_organization_id, p_request_key, p_name, p_profile_ids, p_origin_type,
    p_origin_group_id, p_format, p_repeat_days, p_daily_time, p_caption,
    p_order_mode, p_rotation_seed, p_algorithm_version, p_chunk_size, p_now
  );
  resolved_plan_id := (created ->> 'planId')::uuid;
  select reel_cover_media_asset_id into existing_cover
  from public.bulk_publication_plans where id = resolved_plan_id for update;

  if coalesce((created ->> 'created')::boolean, false) then
    update public.bulk_publication_plans
    set reel_cover_media_asset_id = p_reel_cover_media_asset_id
    where id = resolved_plan_id;
  elsif existing_cover is distinct from p_reel_cover_media_asset_id then
    raise exception using errcode = '23505', message = 'Chave de idempotência já usada com outra capa.';
  end if;
  return created || jsonb_build_object('reelCoverMediaAssetId', p_reel_cover_media_asset_id);
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
    insert into public.publication_items (organization_id, batch_id, profile_id, format, status, execute_at, caption, idempotency_key, reel_cover_media_asset_id)
    select plan_row.organization_id, plan_row.batch_id, profile_plan.profile_id, plan_row.format, 'waiting'::public.publication_item_status, desired.execute_at, plan_row.caption, desired.idempotency_key, plan_row.reel_cover_media_asset_id
    from desired where not exists (select 1 from public.publication_items existing where existing.organization_id = plan_row.organization_id and existing.idempotency_key = desired.idempotency_key)
    on conflict (organization_id, idempotency_key) do nothing returning id, idempotency_key
  ), inserted_media as (
    insert into public.publication_item_media (organization_id, publication_item_id, media_asset_id, position)
    select plan_row.organization_id, inserted.id, desired.media_asset_id, 0 from inserted join desired using (idempotency_key) returning publication_item_id
  ), inserted_events as (
    insert into public.publication_item_events (organization_id, publication_item_id, event_type, previous_status, status, actor_user_id, actor_label, metadata)
    select plan_row.organization_id, inserted.id, 'queued', null, 'waiting', plan_row.created_by, trim(p_worker_id), jsonb_build_object('execute_at', desired.execute_at, 'bulk_plan_id', plan_row.id, 'bulk_chunk_id', chunk_row.id, 'bulk_slot_index', desired.slot_index::text, 'bulk_algorithm_version', plan_row.algorithm_version, 'reel_cover_media_asset_id', plan_row.reel_cover_media_asset_id)
    from inserted join desired using (idempotency_key) returning publication_item_id
  ) select count(*)::bigint into inserted_count from inserted;

  select count(*)::bigint into materialized_count
  from generate_series(range_start, range_end - 1) as slot(slot_index)
  join public.publication_items item on item.organization_id = plan_row.organization_id and item.idempotency_key = concat('bulk:', plan_row.id, ':', profile_plan.profile_id, ':', slot.slot_index) and item.batch_id = plan_row.batch_id and item.profile_id = profile_plan.profile_id and item.format = plan_row.format and item.execute_at = profile_plan.schedule_base_at + ((((slot.slot_index + 1) * plan_row.interval_minutes::bigint)::text || ' minutes')::interval) and item.caption is not distinct from plan_row.caption and item.reel_cover_media_asset_id is not distinct from plan_row.reel_cover_media_asset_id
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
    select 1 from public.publication_generation_jobs job
    cross join lateral jsonb_array_elements(case when jsonb_typeof(job.payload -> 'items') = 'array' then job.payload -> 'items' else '[]'::jsonb end) payload_item(item)
    where job.organization_id = p_organization_id and job.status in ('queued', 'processing', 'paused')
      and jsonb_typeof(payload_item.item -> 'mediaIds') = 'array'
      and exists (select 1 from jsonb_array_elements_text(payload_item.item -> 'mediaIds') media_value(id) where media_value.id = p_media_asset_id::text)
  ) or exists (
    select 1 from public.publication_generation_job_chunks chunk
    join public.publication_generation_jobs job on job.id = chunk.job_id
    cross join lateral jsonb_array_elements(case when jsonb_typeof(chunk.payload) = 'array' then chunk.payload else '[]'::jsonb end) payload_item(item)
    where chunk.organization_id = p_organization_id and job.organization_id = p_organization_id
      and job.status in ('queued', 'processing', 'paused') and chunk.status in ('queued', 'processing', 'failed')
      and jsonb_typeof(payload_item.item -> 'mediaIds') = 'array'
      and exists (select 1 from jsonb_array_elements_text(payload_item.item -> 'mediaIds') media_value(id) where media_value.id = p_media_asset_id::text)
  ) or exists (
    select 1 from public.bulk_publication_plan_media plan_media
    join public.bulk_publication_plans plan on plan.id = plan_media.plan_id
    where plan_media.organization_id = p_organization_id and plan_media.media_asset_id = p_media_asset_id
      and plan.status in ('queued', 'generating', 'paused')
  ) or exists (
    select 1 from public.bulk_publication_plans plan
    where plan.organization_id = p_organization_id and plan.reel_cover_media_asset_id = p_media_asset_id
      and plan.status in ('queued', 'generating', 'paused')
  ) or exists (
    select 1 from public.publication_items item
    where item.organization_id = p_organization_id and item.reel_cover_media_asset_id = p_media_asset_id
      and item.status in ('draft', 'waiting', 'preparing', 'ready', 'publishing', 'failed', 'suspended')
  );
$$;

revoke all on function public.validate_publication_reel_cover() from public;
revoke all on function public.bulk_reel_cover_is_eligible(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.create_bulk_rotation_plan_v2(uuid, text, text, uuid[], text, uuid, public.publication_format, integer, bigint, text, text, text, uuid, text, uuid, smallint, integer, timestamptz) from public, anon;
revoke all on function public.create_bulk_daily_rotation_plan_v2(uuid, text, text, uuid[], text, uuid, public.publication_format, bigint, time, text, text, text, uuid, text, uuid, smallint, integer, timestamptz) from public, anon;
revoke all on function public.process_bulk_rotation_generation_chunk(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.media_asset_is_in_active_generation_job(uuid, uuid) from public, anon;

grant execute on function public.create_bulk_rotation_plan_v2(uuid, text, text, uuid[], text, uuid, public.publication_format, integer, bigint, text, text, text, uuid, text, uuid, smallint, integer, timestamptz) to authenticated, service_role;
grant execute on function public.create_bulk_daily_rotation_plan_v2(uuid, text, text, uuid[], text, uuid, public.publication_format, bigint, time, text, text, text, uuid, text, uuid, smallint, integer, timestamptz) to authenticated, service_role;
grant execute on function public.process_bulk_rotation_generation_chunk(uuid, text, integer) to service_role;
grant execute on function public.media_asset_is_in_active_generation_job(uuid, uuid) to service_role;

notify pgrst, 'reload schema';
