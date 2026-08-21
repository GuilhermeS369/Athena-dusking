-- Leituras compactas para revisão da programação em massa. Contagens grandes
-- são serializadas como texto nas APIs; nenhuma função desta migration reserva dados.

create or replace function public.get_bulk_rotation_media_summary(
  p_organization_id uuid,
  p_origin_type text,
  p_origin_group_id uuid,
  p_format public.publication_format
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with authorized as (
    select 1 where public.is_organization_member(p_organization_id)
  ), origin_assets as (
    select asset.id, asset.kind, asset.status, asset.deleted_at, asset.deletion_requested_at,
      public.media_asset_has_storage_object(asset.storage_path) as has_storage
    from public.media_assets asset, authorized
    where asset.organization_id = p_organization_id
      and (
        (p_origin_type = 'group' and p_origin_group_id is not null and exists (
          select 1 from public.media_group_assignments assignment
          where assignment.organization_id = p_organization_id
            and assignment.group_id = p_origin_group_id and assignment.media_asset_id = asset.id
        ))
        or (p_origin_type = 'ungrouped' and p_origin_group_id is null and not exists (
          select 1 from public.media_group_assignments assignment
          where assignment.organization_id = p_organization_id and assignment.media_asset_id = asset.id
        ))
      )
  ), classified as (
    select *, case
      when deleted_at is not null or status = 'deleted' then 'deleted'
      when deletion_requested_at is not null then 'pending_deletion'
      when status <> 'ready' then 'not_ready'
      when not has_storage then 'missing_storage'
      when not (p_format = 'story' or (p_format = 'image' and kind = 'image') or (p_format = 'reel' and kind = 'video')) then 'incompatible'
      else 'eligible'
    end as eligibility
    from origin_assets
  )
  select jsonb_build_object(
    'totalFound', count(*)::bigint::text,
    'eligible', count(*) filter (where eligibility = 'eligible')::bigint::text,
    'excluded', jsonb_build_object(
      'deleted', count(*) filter (where eligibility = 'deleted')::bigint::text,
      'pendingDeletion', count(*) filter (where eligibility = 'pending_deletion')::bigint::text,
      'notReady', count(*) filter (where eligibility = 'not_ready')::bigint::text,
      'missingStorage', count(*) filter (where eligibility = 'missing_storage')::bigint::text,
      'incompatible', count(*) filter (where eligibility = 'incompatible')::bigint::text
    )
  ) from classified;
$$;

create or replace function public.list_bulk_rotation_media_ids(
  p_organization_id uuid,
  p_origin_type text,
  p_origin_group_id uuid,
  p_format public.publication_format,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null,
  p_limit integer default 31
)
returns table (media_asset_id uuid, created_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select asset.id, asset.created_at
  from public.media_assets asset
  where public.is_organization_member(p_organization_id)
    and asset.organization_id = p_organization_id
    and asset.deleted_at is null and asset.deletion_requested_at is null and asset.status = 'ready'
    and public.media_asset_has_storage_object(asset.storage_path)
    and (p_format = 'story' or (p_format = 'image' and asset.kind = 'image') or (p_format = 'reel' and asset.kind = 'video'))
    and (
      (p_origin_type = 'group' and p_origin_group_id is not null and exists (
        select 1 from public.media_group_assignments assignment
        where assignment.organization_id = p_organization_id and assignment.group_id = p_origin_group_id
          and assignment.media_asset_id = asset.id
      ))
      or (p_origin_type = 'ungrouped' and p_origin_group_id is null and not exists (
        select 1 from public.media_group_assignments assignment
        where assignment.organization_id = p_organization_id and assignment.media_asset_id = asset.id
      ))
    )
    and (p_cursor_created_at is null or asset.created_at > p_cursor_created_at
      or (asset.created_at = p_cursor_created_at and asset.id > p_cursor_id))
  order by asset.created_at, asset.id
  limit greatest(1, least(coalesce(p_limit, 31), 101));
$$;

create or replace function public.review_bulk_rotation_schedule(
  p_organization_id uuid,
  p_profile_ids uuid[],
  p_interval_minutes integer,
  p_duration_days bigint,
  p_now timestamptz default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  resolved_now timestamptz := coalesce(p_now, timezone('utc', now()));
  requested_profile_count bigint;
  online_profile_count bigint;
  resolved_slots numeric;
  resolved_expected numeric;
  sample_first_execute_at timestamptz;
  sample_last_execute_at timestamptz;
begin
  if auth.uid() is null or not public.has_organization_role(
    p_organization_id, array['admin', 'operator']::public.organization_role[]
  ) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;
  if p_profile_ids is null or cardinality(p_profile_ids) = 0 or array_position(p_profile_ids, null) is not null then
    raise exception using errcode = '22023', message = 'Selecione pelo menos um perfil válido.';
  end if;
  if p_interval_minutes is null or p_interval_minutes < 1 or p_duration_days is null or p_duration_days < 1 then
    raise exception using errcode = '22023', message = 'Intervalo e duração precisam ser positivos.';
  end if;

  resolved_slots := trunc((p_duration_days::numeric * 1440::numeric) / p_interval_minutes::numeric);
  if resolved_slots < 1 or resolved_slots > 9223372036854775807::numeric then
    raise exception using errcode = '22003', message = 'Quantidade de slots não cabe em bigint.';
  end if;

  select count(*)::bigint into requested_profile_count
  from (select distinct value from unnest(p_profile_ids) as input(value)) requested;
  select count(*)::bigint into online_profile_count
  from (select distinct value from unnest(p_profile_ids) as input(value)) requested
  join public.instagram_profiles profile_row on profile_row.id = requested.value
  where profile_row.organization_id = p_organization_id
    and profile_row.deleted_at is null and profile_row.status = 'online';
  if requested_profile_count <> online_profile_count then
    raise exception using errcode = 'P0001', message = 'O conjunto de perfis mudou; atualize a seleção antes de revisar.';
  end if;

  resolved_expected := requested_profile_count::numeric * resolved_slots;
  if resolved_expected > 9223372036854775807::numeric then
    raise exception using errcode = '22003', message = 'Projeção total não cabe em bigint.';
  end if;

  begin
    with requested as (
      select distinct value as profile_id from unnest(p_profile_ids) as input(value)
    ), profile_bases as (
      select requested.profile_id, greatest(
        resolved_now,
        coalesce((
          select max(item.execute_at)
          from public.publication_items item
          where item.organization_id = p_organization_id
            and item.profile_id = requested.profile_id
            and item.status in ('waiting', 'ready', 'preparing', 'publishing')
            and item.execute_at is not null
        ), resolved_now),
        coalesce((
          select max(horizon.reserved_through)
          from public.bulk_publication_profile_horizons horizon
          where horizon.organization_id = p_organization_id
            and horizon.profile_id = requested.profile_id and horizon.status = 'active'
        ), resolved_now)
      ) as schedule_base
      from requested
    )
    select
      min(schedule_base + ((p_interval_minutes::text || ' minutes')::interval)),
      max(schedule_base + (((resolved_slots * p_interval_minutes::numeric)::text || ' minutes')::interval))
    into sample_first_execute_at, sample_last_execute_at
    from profile_bases;
  exception when datetime_field_overflow then
    raise exception using errcode = '22008', message = 'Horizonte solicitado excede o intervalo de datas suportado.';
  end;

  return jsonb_build_object(
    'profileCount', online_profile_count::text,
    'slotsPerProfile', resolved_slots::bigint::text,
    'expectedPublications', resolved_expected::bigint::text,
    'firstExecuteAt', sample_first_execute_at,
    'lastExecuteAt', sample_last_execute_at,
    'reviewedAt', resolved_now
  );
end;
$$;

create or replace function public.get_bulk_rotation_plan_progress(
  p_organization_id uuid,
  p_plan_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'planId', plan.id,
    'batchId', plan.batch_id,
    'name', plan.name,
    'status', plan.status,
    'format', plan.format,
    'profileCount', plan.profile_count::text,
    'mediaCount', plan.media_count::text,
    'slotsPerProfile', plan.slots_per_profile::text,
    'expectedPublications', plan.expected_publications::text,
    'generatedPublications', plan.generated_publications::text,
    'suspendedPublications', plan.suspended_publications::text,
    'ignoredPublications', plan.ignored_publications::text,
    'failedPublications', plan.failed_publications::text,
    'expectedChunks', plan.expected_chunks::text,
    'chunks', jsonb_build_object(
      'queued', coalesce(chunks.queued, 0)::bigint::text,
      'processing', coalesce(chunks.processing, 0)::bigint::text,
      'paused', coalesce(chunks.paused, 0)::bigint::text,
      'completed', coalesce(chunks.completed, 0)::bigint::text,
      'failed', coalesce(chunks.failed, 0)::bigint::text,
      'cancelled', coalesce(chunks.cancelled, 0)::bigint::text
    ),
    'firstExecuteAt', profile_dates.first_execute_at,
    'lastExecuteAt', profile_dates.last_execute_at,
    'startedAt', plan.started_at,
    'completedAt', plan.completed_at,
    'createdAt', plan.created_at,
    'updatedAt', plan.updated_at
  )
  from public.bulk_publication_plans plan
  left join lateral (
    select
      count(*) filter (where chunk.status = 'queued') as queued,
      count(*) filter (where chunk.status = 'processing') as processing,
      count(*) filter (where chunk.status = 'paused') as paused,
      count(*) filter (where chunk.status = 'completed') as completed,
      count(*) filter (where chunk.status = 'failed') as failed,
      count(*) filter (where chunk.status = 'cancelled') as cancelled
    from public.bulk_publication_generation_chunks chunk
    where chunk.plan_id = plan.id
  ) chunks on true
  left join lateral (
    select min(profile_plan.first_execute_at) as first_execute_at,
      max(profile_plan.last_execute_at) as last_execute_at
    from public.bulk_publication_plan_profiles profile_plan
    where profile_plan.plan_id = plan.id
  ) profile_dates on true
  where public.is_organization_member(p_organization_id)
    and plan.organization_id = p_organization_id and plan.id = p_plan_id;
$$;

revoke all on function public.get_bulk_rotation_media_summary(uuid, text, uuid, public.publication_format) from public, anon;
revoke all on function public.list_bulk_rotation_media_ids(uuid, text, uuid, public.publication_format, timestamptz, uuid, integer) from public, anon;
revoke all on function public.review_bulk_rotation_schedule(uuid, uuid[], integer, bigint, timestamptz) from public, anon;
revoke all on function public.get_bulk_rotation_plan_progress(uuid, uuid) from public, anon;
grant execute on function public.get_bulk_rotation_media_summary(uuid, text, uuid, public.publication_format) to authenticated, service_role;
grant execute on function public.list_bulk_rotation_media_ids(uuid, text, uuid, public.publication_format, timestamptz, uuid, integer) to authenticated, service_role;
grant execute on function public.review_bulk_rotation_schedule(uuid, uuid[], integer, bigint, timestamptz) to authenticated, service_role;
grant execute on function public.get_bulk_rotation_plan_progress(uuid, uuid) to authenticated, service_role;
