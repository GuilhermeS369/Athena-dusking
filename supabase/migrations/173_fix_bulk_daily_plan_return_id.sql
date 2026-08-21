-- Corrige a resposta do criador diário. A versão inicial referenciava um
-- identificador inexistente ao montar o JSON de sucesso, fazendo a API
-- devolver o erro genérico após concluir a transação.

create or replace function public.create_bulk_daily_rotation_plan(
  p_organization_id uuid, p_request_key text, p_name text, p_profile_ids uuid[], p_origin_type text, p_origin_group_id uuid,
  p_format public.publication_format, p_repeat_days bigint, p_daily_time time, p_caption text, p_order_mode text,
  p_rotation_seed text, p_algorithm_version smallint default 1, p_chunk_size integer default 500, p_now timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  created jsonb;
  v_plan_id uuid;
  profile_row record;
  first_daily timestamptz;
  source_base timestamptz;
begin
  if p_daily_time is null or p_repeat_days is null or p_repeat_days < 1 then
    raise exception using errcode = '22023', message = 'Quantidade de dias e horário diário são obrigatórios.';
  end if;
  created := public.create_bulk_rotation_plan(p_organization_id, p_request_key, p_name, p_profile_ids, p_origin_type,
    p_origin_group_id, p_format, 1440, p_repeat_days, p_caption, p_order_mode, p_rotation_seed, p_algorithm_version, p_chunk_size, p_now);
  v_plan_id := (created ->> 'planId')::uuid;
  if coalesce((created ->> 'created')::boolean, false) = false then return created; end if;
  update public.bulk_publication_plans set schedule_mode = 'daily_time', daily_time = p_daily_time where id = v_plan_id;
  for profile_row in select * from public.bulk_publication_plan_profiles where plan_id = v_plan_id for update loop
    source_base := profile_row.schedule_base_at;
    first_daily := case when ((date_trunc('day', source_base at time zone 'America/Sao_Paulo') + p_daily_time) at time zone 'America/Sao_Paulo') > source_base
      then ((date_trunc('day', source_base at time zone 'America/Sao_Paulo') + p_daily_time) at time zone 'America/Sao_Paulo')
      else ((date_trunc('day', source_base at time zone 'America/Sao_Paulo') + p_daily_time + interval '1 day') at time zone 'America/Sao_Paulo') end;
    update public.bulk_publication_plan_profiles set schedule_base_at = first_daily - interval '1 day', first_execute_at = first_daily,
      last_execute_at = first_daily + ((p_repeat_days - 1)::text || ' days')::interval, total_slot_count = p_repeat_days where id = profile_row.id;
    update public.bulk_publication_profile_horizons set reserved_from = first_daily - interval '1 day', first_execute_at = first_daily,
      reserved_through = first_daily + ((p_repeat_days - 1)::text || ' days')::interval, slot_count = p_repeat_days where plan_profile_id = profile_row.id and status = 'active';
  end loop;
  return jsonb_build_object('created', true, 'planId', v_plan_id, 'batchId', created ->> 'batchId',
    'profileCount', created ->> 'profileCount', 'mediaCount', created ->> 'mediaCount', 'slotsPerProfile', p_repeat_days::text,
    'expectedPublications', (p_repeat_days * (created ->> 'profileCount')::bigint)::text,
    'firstExecuteAt', (select min(first_execute_at) from public.bulk_publication_plan_profiles where plan_id = v_plan_id),
    'lastExecuteAt', (select max(last_execute_at) from public.bulk_publication_plan_profiles where plan_id = v_plan_id));
end;
$$;

revoke all on function public.create_bulk_daily_rotation_plan(uuid, text, text, uuid[], text, uuid, public.publication_format, bigint, time, text, text, text, smallint, integer, timestamptz) from public, anon;
grant execute on function public.create_bulk_daily_rotation_plan(uuid, text, text, uuid[], text, uuid, public.publication_format, bigint, time, text, text, text, smallint, integer, timestamptz) to authenticated, service_role;
notify pgrst, 'reload schema';
