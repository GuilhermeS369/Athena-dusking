-- Completa o reparo da janela 303/304: alguns chunks foram reabertos após o
-- passo legado 500, mas os contadores de falha do chunk/perfil permaneceram.

create or replace function public.repair_bulk_rotation_retry_counter_residue(
  p_plan_id uuid,
  p_expected_name text,
  p_expected_profiles integer,
  p_hold_reason text default 'operator_ordered_recovery_2026_08_28'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  plan_row public.bulk_publication_plans%rowtype;
  candidate_count integer;
  repaired_chunks integer;
  repaired_profiles integer;
  hold_marker text := 'Pausa operacional: '
    || left(coalesce(nullif(trim(p_hold_reason), ''), 'operator_ordered_recovery_2026_08_28'), 120);
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Somente service_role pode reparar resíduos de retry.';
  end if;
  if p_expected_profiles not between 1 and 20 then
    raise exception using errcode = '22023', message = 'Quantidade esperada inválida.';
  end if;

  select * into plan_row from public.bulk_publication_plans plan
  where plan.id = p_plan_id for update;
  if plan_row.id is null or plan_row.name <> trim(p_expected_name) then
    raise exception using errcode = 'P0002', message = 'Plano não encontrado ou nome divergente.';
  end if;
  if plan_row.status <> 'paused' then
    raise exception using errcode = '22023', message = 'Plano precisa permanecer em hold durante o reparo.';
  end if;

  select count(*)::integer into candidate_count
  from public.bulk_publication_generation_chunks chunk
  join public.bulk_publication_plan_profiles profile_plan on profile_plan.id = chunk.plan_profile_id
  where chunk.plan_id = p_plan_id
    and chunk.status = 'paused'
    and chunk.last_error_message = hold_marker
    and chunk.lease_until is null
    and chunk.retry_exhausted_at is null
    and chunk.consecutive_failure_count = 0
    and chunk.next_slot_index = chunk.slot_start
    and chunk.generated_items = 0
    and chunk.failed_items = chunk.slot_count
    and profile_plan.status = 'failed'
    and profile_plan.next_slot_index = chunk.slot_start
    and profile_plan.generated_slot_count = 0
    and profile_plan.failed_slot_count = profile_plan.total_slot_count;

  if candidate_count <> p_expected_profiles then
    raise exception using errcode = '22023',
      message = format('Resíduo divergente: esperado %s, encontrado %s.', p_expected_profiles, candidate_count);
  end if;

  with candidates as (
    select chunk.id, chunk.plan_profile_id
    from public.bulk_publication_generation_chunks chunk
    join public.bulk_publication_plan_profiles profile_plan on profile_plan.id = chunk.plan_profile_id
    where chunk.plan_id = p_plan_id
      and chunk.status = 'paused'
      and chunk.last_error_message = hold_marker
      and chunk.lease_until is null
      and chunk.retry_exhausted_at is null
      and chunk.consecutive_failure_count = 0
      and chunk.next_slot_index = chunk.slot_start
      and chunk.generated_items = 0
      and chunk.failed_items = chunk.slot_count
      and profile_plan.status = 'failed'
      and profile_plan.next_slot_index = chunk.slot_start
      and profile_plan.generated_slot_count = 0
      and profile_plan.failed_slot_count = profile_plan.total_slot_count
    order by chunk.id
    for update of chunk, profile_plan
  ), repaired as (
    update public.bulk_publication_generation_chunks chunk
    set failed_items = 0
    from candidates
    where chunk.id = candidates.id
    returning candidates.plan_profile_id
  ), profiles as (
    update public.bulk_publication_plan_profiles profile_plan
    set status = 'queued', failed_slot_count = 0
    where profile_plan.id in (select repaired.plan_profile_id from repaired)
    returning profile_plan.id
  )
  select
    (select count(*)::integer from repaired),
    (select count(*)::integer from profiles)
  into repaired_chunks, repaired_profiles;

  update public.bulk_publication_plans plan
  set metadata = plan.metadata || jsonb_build_object(
    'retry_counter_residue_repaired_at', timezone('utc', now()),
    'retry_counter_residue_profiles', repaired_profiles
  )
  where plan.id = p_plan_id;
  perform public.refresh_bulk_rotation_plan_state(p_plan_id);

  return jsonb_build_object(
    'planId', p_plan_id,
    'planName', plan_row.name,
    'repairedChunks', repaired_chunks,
    'repairedProfiles', repaired_profiles,
    'holdPreserved', true
  );
end;
$$;

revoke all on function public.repair_bulk_rotation_retry_counter_residue(uuid, text, integer, text)
  from public, anon, authenticated;
grant execute on function public.repair_bulk_rotation_retry_counter_residue(uuid, text, integer, text)
  to service_role;

notify pgrst, 'reload schema';
