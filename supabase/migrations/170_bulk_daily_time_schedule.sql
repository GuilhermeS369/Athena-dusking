-- Horário diário fixo para a programação em massa. O modo antigo de intervalo
-- permanece intacto; este modo reutiliza o gerador incremental com 1.440 min.

alter table public.bulk_publication_plans
  add column if not exists schedule_mode text not null default 'interval'
    check (schedule_mode in ('interval', 'daily_time')),
  add column if not exists daily_time time;

alter table public.bulk_publication_plans
  drop constraint if exists bulk_publication_plans_daily_time_check;
alter table public.bulk_publication_plans
  add constraint bulk_publication_plans_daily_time_check
  check ((schedule_mode = 'interval' and daily_time is null) or (schedule_mode = 'daily_time' and daily_time is not null));

create or replace function public.review_bulk_daily_rotation_schedule(
  p_organization_id uuid,
  p_profile_ids uuid[],
  p_repeat_days bigint,
  p_daily_time time,
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
  sample_first_execute_at timestamptz;
  sample_last_execute_at timestamptz;
begin
  if auth.uid() is null or not public.has_organization_role(p_organization_id, array['admin', 'operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;
  if p_profile_ids is null or cardinality(p_profile_ids) = 0 or array_position(p_profile_ids, null) is not null then
    raise exception using errcode = '22023', message = 'Selecione pelo menos um perfil válido.';
  end if;
  if p_repeat_days is null or p_repeat_days < 1 or p_daily_time is null then
    raise exception using errcode = '22023', message = 'Quantidade de dias e horário diário são obrigatórios.';
  end if;
  select count(*)::bigint into requested_profile_count from (select distinct value from unnest(p_profile_ids) as input(value)) requested;
  select count(*)::bigint into online_profile_count
  from (select distinct value from unnest(p_profile_ids) as input(value)) requested
  join public.instagram_profiles profile_row on profile_row.id = requested.value
  where profile_row.organization_id = p_organization_id and profile_row.deleted_at is null and profile_row.status = 'online';
  if requested_profile_count <> online_profile_count then
    raise exception using errcode = 'P0001', message = 'O conjunto de perfis mudou; atualize a seleção antes de revisar.';
  end if;
  with requested as (
    select distinct value as profile_id from unnest(p_profile_ids) as input(value)
  ), bases as (
    select requested.profile_id, greatest(
      resolved_now,
      coalesce((select max(item.execute_at) from public.publication_items item where item.organization_id = p_organization_id and item.profile_id = requested.profile_id and item.status in ('waiting', 'ready', 'preparing', 'publishing') and item.execute_at is not null), resolved_now),
      coalesce((select max(horizon.reserved_through) from public.bulk_publication_profile_horizons horizon where horizon.organization_id = p_organization_id and horizon.profile_id = requested.profile_id and horizon.status = 'active'), resolved_now)
    ) as schedule_base from requested
  ), daily as (
    select case when ((date_trunc('day', schedule_base at time zone 'America/Sao_Paulo') + p_daily_time) at time zone 'America/Sao_Paulo') > schedule_base
      then ((date_trunc('day', schedule_base at time zone 'America/Sao_Paulo') + p_daily_time) at time zone 'America/Sao_Paulo')
      else ((date_trunc('day', schedule_base at time zone 'America/Sao_Paulo') + p_daily_time + interval '1 day') at time zone 'America/Sao_Paulo') end as first_execute_at
    from bases
  ) select min(first_execute_at), max(first_execute_at + ((p_repeat_days - 1)::text || ' days')::interval)
    into sample_first_execute_at, sample_last_execute_at from daily;
  return jsonb_build_object('profileCount', online_profile_count::text, 'slotsPerProfile', p_repeat_days::text,
    'expectedPublications', (online_profile_count * p_repeat_days)::text, 'firstExecuteAt', sample_first_execute_at,
    'lastExecuteAt', sample_last_execute_at, 'reviewedAt', resolved_now);
end;
$$;

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

revoke all on function public.review_bulk_daily_rotation_schedule(uuid, uuid[], bigint, time, timestamptz) from public, anon;
revoke all on function public.create_bulk_daily_rotation_plan(uuid, text, text, uuid[], text, uuid, public.publication_format, bigint, time, text, text, text, smallint, integer, timestamptz) from public, anon;
grant execute on function public.review_bulk_daily_rotation_schedule(uuid, uuid[], bigint, time, timestamptz) to authenticated, service_role;
grant execute on function public.create_bulk_daily_rotation_plan(uuid, text, text, uuid[], text, uuid, public.publication_format, bigint, time, text, text, text, smallint, integer, timestamptz) to authenticated, service_role;
notify pgrst, 'reload schema';
