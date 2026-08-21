create or replace function public.repair_luiz_miguel_daily_story_start(
  p_plan_id uuid,
  p_first_execute_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  plan_row public.bulk_publication_plans%rowtype;
  profile_count bigint;
  active_item_count bigint;
  updated_item_count bigint;
  target_last_execute_at timestamptz;
begin
  select * into plan_row from public.bulk_publication_plans where id = p_plan_id for update;
  if plan_row.id is null
    or plan_row.name <> 'STORY OFICIAL LUIZ MIGUEL 17-08 2 DAYS'
    or plan_row.batch_id <> '71703a97-22b2-441a-9fc6-eb139f339d24'::uuid
    or plan_row.format <> 'story' or plan_row.schedule_mode <> 'daily_time'
    or plan_row.daily_time <> '07:00:00'::time or plan_row.duration_days <> 2 or plan_row.slots_per_profile <> 2 then
    raise exception using errcode = '22023', message = 'O plano não corresponde ao reparo diário autorizado.';
  end if;
  if (p_first_execute_at at time zone 'America/Sao_Paulo') <> '2026-08-18 07:00:00'::timestamp then
    raise exception using errcode = '22023', message = 'O reparo aceita somente 18/08/2026 às 07:00 em São Paulo.';
  end if;
  select count(*)::bigint into profile_count from public.bulk_publication_plan_profiles where plan_id = plan_row.id;
  if profile_count <> plan_row.profile_count or exists (
    select 1 from public.bulk_publication_plan_profiles where plan_id = plan_row.id and total_slot_count <> 2
  ) then
    raise exception using errcode = '23514', message = 'A estrutura de perfis do plano não confere.';
  end if;

  target_last_execute_at := p_first_execute_at + interval '1 day';
  update public.bulk_publication_plan_profiles as profile_plan
  set schedule_base_at = p_first_execute_at - interval '1 day',
      first_execute_at = p_first_execute_at,
      last_execute_at = target_last_execute_at
  where profile_plan.plan_id = plan_row.id;
  update public.bulk_publication_profile_horizons as horizon
  set reserved_from = p_first_execute_at - interval '1 day',
      first_execute_at = p_first_execute_at,
      reserved_through = target_last_execute_at
  where horizon.plan_id = plan_row.id and horizon.status = 'active';

  select count(*)::bigint into active_item_count
  from public.publication_items as item
  where item.batch_id = plan_row.batch_id and item.status in ('waiting', 'ready', 'preparing', 'publishing')
    and item.idempotency_key like 'bulk:' || plan_row.id::text || ':%';
  if active_item_count > profile_count * 2 then
    raise exception using errcode = '23514', message = 'O lote contém mais itens ativos do que o plano permite.';
  end if;
  update public.publication_items as item
  set execute_at = p_first_execute_at + make_interval(days => split_part(item.idempotency_key, ':', 4)::integer)
  where item.batch_id = plan_row.batch_id and item.status in ('waiting', 'ready', 'preparing', 'publishing')
    and item.idempotency_key like 'bulk:' || plan_row.id::text || ':%';
  get diagnostics updated_item_count = row_count;

  return jsonb_build_object('planId', plan_row.id, 'profileCount', profile_count::text,
    'updatedItemCount', updated_item_count::text, 'firstExecuteAt', p_first_execute_at, 'lastExecuteAt', target_last_execute_at);
end;
$$;

revoke all on function public.repair_luiz_miguel_daily_story_start(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.repair_luiz_miguel_daily_story_start(uuid, timestamptz) to service_role;
notify pgrst, 'reload schema';
