-- A reserva compacta protege somente slots do mesmo formato de publicação.
-- Reels, Stories e imagens podem ocupar o mesmo instante no mesmo perfil.

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
      select 1
      from public.publication_items occupied
      where occupied.organization_id = new.organization_id
        and occupied.profile_id = new.profile_id
        and occupied.format = new.format
        and occupied.execute_at = new.execute_at
        and occupied.status in ('waiting', 'ready', 'preparing', 'publishing')
        and occupied.id <> new.id
    ) then
    raise exception using errcode = '23505', message = 'active_publication_slot_conflict';
  end if;

  if tg_op = 'INSERT'
    and new.execute_at is not null
    and new.status in ('waiting', 'ready', 'preparing', 'publishing')
    and exists (
      select 1
      from public.bulk_publication_profile_horizons horizon
      join public.bulk_publication_plans plan on plan.id = horizon.plan_id
      where horizon.organization_id = new.organization_id
        and horizon.profile_id = new.profile_id
        and plan.format = new.format
        and horizon.status = 'active'
        and new.execute_at >= horizon.first_execute_at
        and new.execute_at <= horizon.reserved_through
        and new.batch_id <> plan.batch_id
        and new.created_at >= horizon.created_at
    ) then
    raise exception using errcode = '23505', message = 'bulk_publication_horizon_conflict';
  end if;

  return new;
end;
$$;

create or replace function public.create_bulk_rotation_plan(
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
  p_algorithm_version smallint default 1,
  p_chunk_size integer default 500,
  p_now timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  resolved_now timestamptz := coalesce(p_now, timezone('utc', now()));
  resolved_user_id uuid := auth.uid();
  clean_request_key text := trim(coalesce(p_request_key, ''));
  clean_name text := trim(coalesce(p_name, ''));
  clean_seed text := trim(coalesce(p_rotation_seed, ''));
  requested_profile_count bigint;
  online_profile_count bigint;
  resolved_media_count bigint;
  resolved_slots numeric;
  resolved_expected numeric;
  resolved_expected_chunks numeric;
  resolved_request_hash text;
  existing_plan public.bulk_publication_plans%rowtype;
  created_plan public.bulk_publication_plans%rowtype;
  created_batch public.publication_batches%rowtype;
  profile_record record;
  profile_plan public.bulk_publication_plan_profiles%rowtype;
  active_last timestamptz;
  reserved_last timestamptz;
  schedule_base timestamptz;
  first_execute timestamptz;
  last_execute timestamptz;
  media_seed_offset bigint;
begin
  if resolved_user_id is null or not public.has_organization_role(
    p_organization_id, array['admin', 'operator']::public.organization_role[]
  ) then raise exception using errcode = '42501', message = 'Ação não permitida.'; end if;
  if char_length(clean_request_key) not between 16 and 240 then raise exception using errcode = '22023', message = 'Chave de idempotência inválida.'; end if;
  if char_length(clean_name) not between 1 and 160 then raise exception using errcode = '22023', message = 'Nome do lote inválido.'; end if;
  if p_profile_ids is null or cardinality(p_profile_ids) = 0 or array_position(p_profile_ids, null) is not null then raise exception using errcode = '22023', message = 'Selecione pelo menos um perfil válido.'; end if;
  if p_origin_type not in ('group', 'ungrouped') or (p_origin_type = 'group' and p_origin_group_id is null) or (p_origin_type = 'ungrouped' and p_origin_group_id is not null) then raise exception using errcode = '22023', message = 'Origem de mídia inválida.'; end if;
  if p_format not in ('image', 'reel', 'story') then raise exception using errcode = '22023', message = 'Formato inválido para programação em massa.'; end if;
  if p_interval_minutes is null or p_interval_minutes < 1 then raise exception using errcode = '22023', message = 'Intervalo precisa ser um inteiro positivo.'; end if;
  if p_duration_days is null or p_duration_days < 1 then raise exception using errcode = '22023', message = 'Duração precisa ser positiva.'; end if;
  if p_caption is not null and char_length(p_caption) > 2200 then raise exception using errcode = '22023', message = 'Legenda excede 2.200 caracteres.'; end if;
  if p_order_mode not in ('same_order', 'diversified') or clean_seed = '' or p_algorithm_version <> 1 then raise exception using errcode = '22023', message = 'Configuração de rotação inválida.'; end if;
  if p_chunk_size not between 1 and 1000 then raise exception using errcode = '22023', message = 'Tamanho de chunk deve estar entre 1 e 1.000.'; end if;

  resolved_request_hash := encode(extensions.digest(concat_ws('|', clean_name, p_origin_type, coalesce(p_origin_group_id::text, ''), p_format::text, p_interval_minutes::text, p_duration_days::text, coalesce(p_caption, ''), p_order_mode, clean_seed, p_algorithm_version::text, p_chunk_size::text, (select string_agg(value::text, ',' order by first_ordinal) from (select value, min(ordinality) as first_ordinal from unnest(p_profile_ids) with ordinality input(value, ordinality) group by value) ordered_profiles)), 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':' || clean_request_key, 0));
  select * into existing_plan from public.bulk_publication_plans where organization_id = p_organization_id and request_key = clean_request_key;
  if existing_plan.id is not null then
    if existing_plan.request_hash <> resolved_request_hash then raise exception using errcode = '23505', message = 'Chave de idempotência já usada com outro conteúdo.'; end if;
    return jsonb_build_object('created', false, 'planId', existing_plan.id, 'batchId', existing_plan.batch_id, 'profileCount', existing_plan.profile_count::text, 'mediaCount', existing_plan.media_count::text, 'slotsPerProfile', existing_plan.slots_per_profile::text, 'expectedPublications', existing_plan.expected_publications::text);
  end if;

  resolved_slots := trunc((p_duration_days::numeric * 1440::numeric) / p_interval_minutes::numeric);
  if resolved_slots < 1 or resolved_slots > 9223372036854775807::numeric then raise exception using errcode = '22003', message = 'Quantidade de slots não cabe em bigint.'; end if;
  select count(*)::bigint into requested_profile_count from (select distinct value from unnest(p_profile_ids) as input(value)) requested;
  select count(*)::bigint into online_profile_count from (select distinct value from unnest(p_profile_ids) as input(value)) requested join public.instagram_profiles profile_row on profile_row.id = requested.value where profile_row.organization_id = p_organization_id and profile_row.deleted_at is null and profile_row.status = 'online';
  if requested_profile_count <> online_profile_count then raise exception using errcode = 'P0001', message = 'O conjunto de perfis mudou; revise novamente antes de confirmar.'; end if;
  if p_origin_type = 'group' and not exists (select 1 from public.profile_groups group_row where group_row.id = p_origin_group_id and group_row.organization_id = p_organization_id and group_row.deleted_at is null) then raise exception using errcode = '23514', message = 'Grupo de origem inválido.'; end if;

  select count(*)::bigint into resolved_media_count from public.media_assets asset where asset.organization_id = p_organization_id and asset.deleted_at is null and asset.deletion_requested_at is null and asset.status = 'ready' and public.media_asset_has_storage_object(asset.storage_path) and (p_format = 'story' or (p_format = 'image' and asset.kind = 'image') or (p_format = 'reel' and asset.kind = 'video')) and ((p_origin_type = 'group' and exists (select 1 from public.media_group_assignments assignment where assignment.organization_id = p_organization_id and assignment.group_id = p_origin_group_id and assignment.media_asset_id = asset.id)) or (p_origin_type = 'ungrouped' and not exists (select 1 from public.media_group_assignments assignment where assignment.organization_id = p_organization_id and assignment.media_asset_id = asset.id)));
  if resolved_media_count = 0 then raise exception using errcode = '22023', message = 'A origem não possui mídias elegíveis para o formato.'; end if;

  resolved_expected := requested_profile_count::numeric * resolved_slots;
  resolved_expected_chunks := requested_profile_count::numeric;
  if resolved_expected > 9223372036854775807::numeric then raise exception using errcode = '22003', message = 'Projeção total não cabe em bigint.'; end if;
  insert into public.publication_batches (organization_id, created_by, created_by_email, name, status, scheduled_for, review_confirmed_at) values (p_organization_id, resolved_user_id, nullif(auth.jwt() ->> 'email', ''), clean_name, 'queued', resolved_now, resolved_now) returning * into created_batch;
  insert into public.bulk_publication_plans (organization_id, created_by, created_by_email, batch_id, request_key, request_hash, name, format, origin_type, origin_group_id, caption, interval_minutes, duration_days, slots_per_profile, order_mode, algorithm_version, rotation_seed, profile_count, media_count, expected_publications, chunk_size, expected_chunks) values (p_organization_id, resolved_user_id, nullif(auth.jwt() ->> 'email', ''), created_batch.id, clean_request_key, resolved_request_hash, clean_name, p_format, p_origin_type, p_origin_group_id, nullif(p_caption, ''), p_interval_minutes, p_duration_days, resolved_slots::bigint, p_order_mode, p_algorithm_version, clean_seed, requested_profile_count, resolved_media_count, resolved_expected::bigint, p_chunk_size, resolved_expected_chunks::bigint) returning * into created_plan;
  insert into public.bulk_publication_plan_media (plan_id, organization_id, media_asset_id, ordinal, kind, storage_path) select created_plan.id, p_organization_id, eligible.id, (row_number() over (order by eligible.created_at, eligible.id) - 1)::bigint, eligible.kind, eligible.storage_path from public.media_assets eligible where eligible.organization_id = p_organization_id and eligible.deleted_at is null and eligible.deletion_requested_at is null and eligible.status = 'ready' and public.media_asset_has_storage_object(eligible.storage_path) and (p_format = 'story' or (p_format = 'image' and eligible.kind = 'image') or (p_format = 'reel' and eligible.kind = 'video')) and ((p_origin_type = 'group' and exists (select 1 from public.media_group_assignments assignment where assignment.organization_id = p_organization_id and assignment.group_id = p_origin_group_id and assignment.media_asset_id = eligible.id)) or (p_origin_type = 'ungrouped' and not exists (select 1 from public.media_group_assignments assignment where assignment.organization_id = p_organization_id and assignment.media_asset_id = eligible.id)));

  media_seed_offset := mod((hashtextextended(clean_seed, 0)::numeric + 9223372036854775808::numeric), resolved_media_count::numeric)::bigint;
  for profile_record in select requested.value as profile_id, (row_number() over (order by requested.first_ordinal) - 1)::bigint as ordinal from (select value, min(ordinality) as first_ordinal from unnest(p_profile_ids) with ordinality input(value, ordinality) group by value) requested order by requested.first_ordinal loop
    perform pg_advisory_xact_lock(hashtextextended(profile_record.profile_id::text, 0));
    select max(item.execute_at) into active_last from public.publication_items item where item.organization_id = p_organization_id and item.profile_id = profile_record.profile_id and item.format = p_format and item.status in ('waiting', 'ready', 'preparing', 'publishing') and item.execute_at is not null;
    select max(horizon.reserved_through) into reserved_last from public.bulk_publication_profile_horizons horizon join public.bulk_publication_plans horizon_plan on horizon_plan.id = horizon.plan_id where horizon.organization_id = p_organization_id and horizon.profile_id = profile_record.profile_id and horizon.status = 'active' and horizon_plan.format = p_format;
    schedule_base := greatest(resolved_now, coalesce(active_last, resolved_now), coalesce(reserved_last, resolved_now));
    begin
      first_execute := schedule_base + ((p_interval_minutes::text || ' minutes')::interval);
      last_execute := schedule_base + (((resolved_slots * p_interval_minutes::numeric)::text || ' minutes')::interval);
    exception when datetime_field_overflow then raise exception using errcode = '22008', message = 'Horizonte solicitado excede o intervalo de datas suportado.';
    end;
    insert into public.bulk_publication_plan_profiles (plan_id, organization_id, profile_id, ordinal, schedule_base_at, first_execute_at, last_execute_at, total_slot_count, rotation_offset) values (created_plan.id, p_organization_id, profile_record.profile_id, profile_record.ordinal, schedule_base, first_execute, last_execute, resolved_slots::bigint, case when p_order_mode = 'same_order' then 0 else mod(media_seed_offset + profile_record.ordinal, resolved_media_count)::bigint end) returning * into profile_plan;
    insert into public.bulk_publication_profile_horizons (plan_id, plan_profile_id, organization_id, profile_id, reserved_from, first_execute_at, reserved_through, slot_count) values (created_plan.id, profile_plan.id, p_organization_id, profile_record.profile_id, schedule_base, first_execute, last_execute, resolved_slots::bigint);
    insert into public.bulk_publication_generation_chunks (plan_id, plan_profile_id, organization_id, profile_id, chunk_ordinal, slot_start, slot_count, next_slot_index) values (created_plan.id, profile_plan.id, p_organization_id, profile_record.profile_id, profile_record.ordinal, 0, resolved_slots::bigint, 0);
  end loop;
  return jsonb_build_object('created', true, 'planId', created_plan.id, 'batchId', created_plan.batch_id, 'profileCount', created_plan.profile_count::text, 'mediaCount', created_plan.media_count::text, 'slotsPerProfile', created_plan.slots_per_profile::text, 'expectedPublications', created_plan.expected_publications::text, 'firstExecuteAt', (select min(first_execute_at) from public.bulk_publication_plan_profiles where plan_id = created_plan.id), 'lastExecuteAt', (select max(last_execute_at) from public.bulk_publication_plan_profiles where plan_id = created_plan.id));
end;
$$;

revoke all on function public.enforce_active_publication_slot_uniqueness() from public;
revoke all on function public.create_bulk_rotation_plan(uuid, text, text, uuid[], text, uuid, public.publication_format, integer, bigint, text, text, text, smallint, integer, timestamptz) from public, anon;
grant execute on function public.create_bulk_rotation_plan(uuid, text, text, uuid[], text, uuid, public.publication_format, integer, bigint, text, text, text, smallint, integer, timestamptz) to authenticated, service_role;
