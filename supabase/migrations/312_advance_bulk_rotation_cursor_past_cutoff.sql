-- Avança segmentos compactos ainda não materializados quando o horário passa
-- durante uma contenção. Não cria publication_items e preserva holds.

create or replace function public.advance_bulk_rotation_cursor_past_cutoff(
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
  segment_end bigint;
  future_start bigint;
  skipped bigint;
  remaining bigint;
  inspected integer := 0;
  changed integer := 0;
  completed integer := 0;
  ignored bigint := 0;
  decided_at timestamptz := timezone('utc', now());
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Somente service_role pode avançar cursores compactos.';
  end if;
  if p_cutoff is null or p_cutoff > decided_at
    or char_length(trim(coalesce(p_expected_name, ''))) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'Nome esperado ou corte inválido.';
  end if;
  select * into plan_row from public.bulk_publication_plans plan
  where plan.id = p_plan_id for update;
  if plan_row.id is null or plan_row.name <> trim(p_expected_name) then
    raise exception using errcode = 'P0002', message = 'Plano não encontrado ou nome divergente.';
  end if;
  if plan_row.status not in ('queued', 'generating', 'paused') then
    raise exception using errcode = '22023', message = 'Plano não está ativo ou pausado.';
  end if;
  if exists (
    select 1 from public.bulk_publication_generation_chunks chunk
    where chunk.plan_id = p_plan_id and chunk.status = 'processing'
      and chunk.lease_until > decided_at
  ) then
    raise exception using errcode = '55006', message = 'Plano possui chunk com lease ativo.';
  end if;

  for chunk_row in
    select chunk.*, profile_plan.schedule_base_at
    from public.bulk_publication_generation_chunks chunk
    join public.bulk_publication_plan_profiles profile_plan on profile_plan.id = chunk.plan_profile_id
    where chunk.plan_id = p_plan_id
      and chunk.status in ('queued', 'paused')
      and chunk.retry_exhausted_at is null
    order by chunk.chunk_ordinal, chunk.id
    for update of chunk
  loop
    inspected := inspected + 1;
    segment_end := chunk_row.slot_start + chunk_row.slot_count;
    future_start := least(segment_end, greatest(
      chunk_row.next_slot_index,
      floor(extract(epoch from (p_cutoff - chunk_row.schedule_base_at))
        / 60 / plan_row.interval_minutes)::bigint
    ));
    skipped := greatest(future_start - chunk_row.next_slot_index, 0);
    remaining := greatest(segment_end - future_start, 0);
    ignored := ignored + skipped;
    if skipped > 0 then
      changed := changed + 1;
      if remaining = 0 then completed := completed + 1; end if;
      if not p_dry_run then
        update public.bulk_publication_generation_chunks chunk
        set slot_start = case when remaining > 0 then future_start else chunk.slot_start end,
            slot_count = case when remaining > 0 then remaining else chunk.slot_count end,
            next_slot_index = future_start,
            generated_items = case when remaining > 0 then 0 else chunk.generated_items end,
            ignored_items = case when remaining > 0 then 0 else chunk.ignored_items + skipped end,
            failed_items = 0,
            status = case when remaining > 0 then chunk.status else 'completed' end,
            claimed_by = null, lease_until = null,
            consecutive_failure_count = 0, retry_exhausted_at = null,
            last_error_message = case when remaining > 0 then chunk.last_error_message else null end,
            last_progress_at = decided_at,
            completed_at = case when remaining > 0 then chunk.completed_at else decided_at end
        where chunk.id = chunk_row.id;

        update public.bulk_publication_plan_profiles profile_plan
        set next_slot_index = future_start,
            ignored_slot_count = profile_plan.ignored_slot_count + skipped,
            failed_slot_count = 0,
            status = case
              when remaining = 0 then 'completed'
              when chunk_row.status = 'paused' then profile_plan.status
              else 'generating'
            end
        where profile_plan.id = chunk_row.plan_profile_id;

        if remaining = 0 then
          update public.bulk_publication_profile_horizons horizon
          set status = 'completed', released_at = coalesce(horizon.released_at, decided_at)
          where horizon.plan_profile_id = chunk_row.plan_profile_id and horizon.status = 'active';
        end if;
      end if;
    end if;
  end loop;

  if not p_dry_run then
    update public.bulk_publication_plans plan
    set metadata = plan.metadata || jsonb_build_object(
      'cursor_cutoff_advanced_at', decided_at,
      'cursor_cutoff', p_cutoff,
      'cursor_cutoff_ignored_slots', ignored
    ) where plan.id = p_plan_id;
    perform public.refresh_bulk_rotation_plan_state(p_plan_id);
  end if;

  return jsonb_build_object('planId', p_plan_id, 'planName', plan_row.name,
    'dryRun', p_dry_run, 'cutoffAt', p_cutoff, 'inspectedChunks', inspected,
    'changedChunks', changed, 'completedChunks', completed,
    'ignoredSlots', ignored, 'holdPreserved', plan_row.status = 'paused');
end;
$$;

revoke all on function public.advance_bulk_rotation_cursor_past_cutoff(uuid, text, timestamptz, boolean)
  from public, anon, authenticated;
grant execute on function public.advance_bulk_rotation_cursor_past_cutoff(uuid, text, timestamptz, boolean)
  to service_role;

notify pgrst, 'reload schema';
