-- Os wrappers v2 chamavam as funções legadas com o literal inteiro `1`.
-- Como a assinatura legada exige smallint, o PostgreSQL tentava resolver uma
-- sobrecarga inexistente em tempo de execução (SQLSTATE 42883). O cast explícito
-- corrige novas confirmações sem alterar planos ou itens já existentes.

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

revoke all on function public.create_bulk_rotation_plan_v2(uuid, text, text, uuid[], text, uuid, public.publication_format, integer, bigint, text, text, text, smallint, integer, timestamptz) from public, anon;
revoke all on function public.create_bulk_daily_rotation_plan_v2(uuid, text, text, uuid[], text, uuid, public.publication_format, bigint, time, text, text, text, smallint, integer, timestamptz) from public, anon;
grant execute on function public.create_bulk_rotation_plan_v2(uuid, text, text, uuid[], text, uuid, public.publication_format, integer, bigint, text, text, text, smallint, integer, timestamptz) to authenticated, service_role;
grant execute on function public.create_bulk_daily_rotation_plan_v2(uuid, text, text, uuid[], text, uuid, public.publication_format, bigint, time, text, text, text, smallint, integer, timestamptz) to authenticated, service_role;

notify pgrst, 'reload schema';
