-- Recuperação operacional de planos compactos atingidos por timeout.
-- Nunca rematerializa horários vencidos: o cursor avança até o primeiro slot
-- estritamente futuro e o trecho ultrapassado fica contabilizado como ignored.

create or replace function public.set_bulk_rotation_plan_generation_hold(
  p_plan_id uuid,
  p_hold boolean,
  p_reason text default 'operator_ordered_recovery'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  plan_row public.bulk_publication_plans%rowtype;
  affected_chunks integer := 0;
  reason_value text := left(coalesce(nullif(trim(p_reason), ''), 'operator_ordered_recovery'), 120);
  hold_marker text;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Somente service_role pode controlar a geração do plano.';
  end if;

  select * into plan_row
  from public.bulk_publication_plans plan
  where plan.id = p_plan_id
  for update;
  if plan_row.id is null then
    raise exception using errcode = 'P0002', message = 'Plano compacto não encontrado.';
  end if;

  if exists (
    select 1 from public.bulk_publication_generation_chunks chunk
    where chunk.plan_id = p_plan_id and chunk.status = 'processing'
      and chunk.lease_until > timezone('utc', now())
  ) then
    raise exception using errcode = '55006', message = 'Plano possui chunk com lease ativo.';
  end if;

  hold_marker := 'Pausa operacional: ' || reason_value;
  if p_hold then
    update public.bulk_publication_generation_chunks chunk
    set status = 'paused', claimed_by = null, lease_until = null,
        last_error_message = hold_marker
    where chunk.plan_id = p_plan_id
      and chunk.status = 'queued'
      and (chunk.lease_until is null or chunk.lease_until <= timezone('utc', now()));
    get diagnostics affected_chunks = row_count;

    update public.bulk_publication_plans plan
    set status = 'paused', completed_at = null,
        metadata = plan.metadata || jsonb_build_object(
          'generation_hold', true,
          'generation_hold_reason', reason_value,
          'generation_hold_at', timezone('utc', now())
        )
    where plan.id = p_plan_id;
  else
    update public.bulk_publication_generation_chunks chunk
    set status = 'queued', claimed_by = null, lease_until = null,
        last_error_message = null, completed_at = null
    where chunk.plan_id = p_plan_id
      and chunk.status = 'paused'
      and chunk.last_error_message = hold_marker;
    get diagnostics affected_chunks = row_count;

    update public.bulk_publication_plans plan
    set status = 'generating', completed_at = null,
        metadata = (plan.metadata - 'generation_hold' - 'generation_hold_reason' - 'generation_hold_at')
          || jsonb_build_object('generation_released_at', timezone('utc', now()))
    where plan.id = p_plan_id;
    perform public.refresh_bulk_rotation_plan_state(p_plan_id);
  end if;

  return jsonb_build_object(
    'planId', p_plan_id,
    'planName', plan_row.name,
    'hold', p_hold,
    'affectedChunks', affected_chunks,
    'reason', reason_value
  );
end;
$$;

create or replace function public.recover_future_bulk_rotation_timeout_slots(
  p_plan_id uuid,
  p_expected_name text,
  p_cutoff timestamptz,
  p_dry_run boolean default true
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  plan_row public.bulk_publication_plans%rowtype;
  chunk_row record;
  future_start bigint;
  skipped_count bigint;
  future_count bigint;
  repaired_chunks integer := 0;
  future_chunks integer := 0;
  completed_chunks integer := 0;
  ignored_slots bigint := 0;
  future_slots bigint := 0;
  conflict_count integer := 0;
  inspected_chunks integer := 0;
  decided_at timestamptz := timezone('utc', now());
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Somente service_role pode reparar planos compactos.';
  end if;
  if p_cutoff is null or p_cutoff > decided_at
    or char_length(trim(coalesce(p_expected_name, ''))) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'Nome esperado ou corte inválido.';
  end if;

  select * into plan_row
  from public.bulk_publication_plans plan
  where plan.id = p_plan_id
  for update;
  if plan_row.id is null or plan_row.name <> trim(p_expected_name) then
    raise exception using errcode = 'P0002', message = 'Plano não encontrado ou nome divergente.';
  end if;

  if exists (
    select 1 from public.bulk_publication_generation_chunks chunk
    where chunk.plan_id = p_plan_id and chunk.status = 'processing'
      and chunk.lease_until > decided_at
  ) then
    raise exception using errcode = '55006', message = 'Plano possui chunk com lease ativo.';
  end if;

  if exists (
    select 1
    from public.bulk_publication_generation_chunks chunk
    join public.bulk_publication_plan_profiles profile_plan on profile_plan.id = chunk.plan_profile_id
    where chunk.plan_id = p_plan_id
      and chunk.status = 'failed'
      and chunk.retry_exhausted_at is not null
      and lower(coalesce(chunk.last_error_message, '')) like '%statement timeout%'
      and (chunk.generated_items <> 0 or profile_plan.generated_slot_count <> 0)
  ) then
    raise exception using errcode = '22023',
      message = 'Reparo seletivo exige chunks de timeout sem progresso confirmado.';
  end if;

  for chunk_row in
    select chunk.*, profile_plan.schedule_base_at, profile_plan.last_execute_at
    from public.bulk_publication_generation_chunks chunk
    join public.bulk_publication_plan_profiles profile_plan on profile_plan.id = chunk.plan_profile_id
    where chunk.plan_id = p_plan_id
      and chunk.status = 'failed'
      and chunk.retry_exhausted_at is not null
      and lower(coalesce(chunk.last_error_message, '')) like '%statement timeout%'
    order by chunk.chunk_ordinal, chunk.id
    for update of chunk
  loop
    inspected_chunks := inspected_chunks + 1;
    future_start := least(
      chunk_row.slot_start + chunk_row.slot_count,
      greatest(
        chunk_row.next_slot_index,
        floor(
          extract(epoch from (p_cutoff - chunk_row.schedule_base_at))
            / 60 / plan_row.interval_minutes
        )::bigint
      )
    );
    skipped_count := greatest(future_start - chunk_row.next_slot_index, 0);
    future_count := greatest(chunk_row.slot_start + chunk_row.slot_count - future_start, 0);

    if future_count > 0 and exists (
      select 1
      from public.bulk_publication_profile_horizons other_horizon
      where other_horizon.organization_id = chunk_row.organization_id
        and other_horizon.profile_id = chunk_row.profile_id
        and other_horizon.plan_id <> p_plan_id
        and other_horizon.status = 'active'
        and tstzrange(
          chunk_row.schedule_base_at
            + ((((future_start + 1) * plan_row.interval_minutes::bigint)::text || ' minutes')::interval),
          chunk_row.last_execute_at,
          '[]'
        ) && tstzrange(other_horizon.first_execute_at, other_horizon.reserved_through, '[]')
    ) then
      conflict_count := conflict_count + 1;
    end if;

    ignored_slots := ignored_slots + skipped_count;
    future_slots := future_slots + future_count;
    if future_count > 0 then
      future_chunks := future_chunks + 1;
    end if;

    if not p_dry_run then
      if conflict_count > 0 then
        raise exception using errcode = '23P01', message = 'Há horizonte ativo conflitante; reparo cancelado integralmente.';
      end if;

      update public.bulk_publication_generation_chunks chunk
      set slot_start = case when future_count > 0 then future_start else chunk.slot_start end,
          slot_count = case when future_count > 0 then future_count else chunk.slot_count end,
          next_slot_index = future_start,
          generated_items = 0,
          ignored_items = case when future_count > 0 then 0 else chunk.ignored_items + skipped_count end,
          failed_items = 0,
          status = case when future_count > 0 then 'queued' else 'completed' end,
          claimed_by = null,
          lease_until = null,
          consecutive_failure_count = 0,
          retry_exhausted_at = null,
          last_error_message = null,
          last_progress_at = decided_at,
          completed_at = case when future_count > 0 then null else decided_at end
      where chunk.id = chunk_row.id;

      update public.bulk_publication_plan_profiles profile_plan
      set next_slot_index = future_start,
          ignored_slot_count = profile_plan.ignored_slot_count + skipped_count,
          failed_slot_count = 0,
          status = case when future_count > 0 then 'generating' else 'completed' end,
          suspended_at = null,
          suspension_reason = null
      where profile_plan.id = chunk_row.plan_profile_id;

      update public.bulk_publication_profile_horizons horizon
      set status = case when future_count > 0 then 'active' else 'completed' end,
          released_at = case when future_count > 0 then null else coalesce(horizon.released_at, decided_at) end
      where horizon.plan_profile_id = chunk_row.plan_profile_id;

      if future_count > 0 then
        repaired_chunks := repaired_chunks + 1;
      else
        completed_chunks := completed_chunks + 1;
      end if;
    end if;
  end loop;

  if conflict_count > 0 and not p_dry_run then
    raise exception using errcode = '23P01', message = 'Há horizonte ativo conflitante; reparo cancelado integralmente.';
  end if;

  if not p_dry_run then
    update public.bulk_publication_plans plan
    set status = 'generating', completed_at = null,
        metadata = plan.metadata || jsonb_build_object(
          'future_timeout_recovery_at', decided_at,
          'future_timeout_recovery_cutoff', p_cutoff,
          'future_timeout_ignored_slots', ignored_slots,
          'future_timeout_reopened_slots', future_slots
        )
    where plan.id = p_plan_id;
    perform public.refresh_bulk_rotation_plan_state(p_plan_id);
  end if;

  return jsonb_build_object(
    'planId', p_plan_id,
    'planName', plan_row.name,
    'dryRun', p_dry_run,
    'cutoffAt', p_cutoff,
    'inspectedChunks', inspected_chunks,
    'repairedChunks', case when p_dry_run then future_chunks else repaired_chunks end,
    'completedChunks', case when p_dry_run then inspected_chunks - future_chunks else completed_chunks end,
    'ignoredSlots', ignored_slots,
    'futureSlots', future_slots,
    'conflicts', conflict_count,
    'decidedAt', decided_at
  );
end;
$$;

revoke all on function public.set_bulk_rotation_plan_generation_hold(uuid, boolean, text)
  from public, anon, authenticated;
grant execute on function public.set_bulk_rotation_plan_generation_hold(uuid, boolean, text)
  to service_role;

revoke all on function public.recover_future_bulk_rotation_timeout_slots(uuid, text, timestamptz, boolean)
  from public, anon, authenticated;
grant execute on function public.recover_future_bulk_rotation_timeout_slots(uuid, text, timestamptz, boolean)
  to service_role;

notify pgrst, 'reload schema';
