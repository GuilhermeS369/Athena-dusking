-- A prévia precisa usar a mesma regra da confirmação atômica: horários de
-- formatos distintos não ocupam slots entre si no mesmo perfil.

create or replace function public.review_bulk_rotation_schedule(
  p_organization_id uuid,
  p_profile_ids uuid[],
  p_interval_minutes integer,
  p_duration_days bigint,
  p_format public.publication_format,
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
  if auth.uid() is null or not public.has_organization_role(p_organization_id, array['admin', 'operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;
  if p_profile_ids is null or cardinality(p_profile_ids) = 0 or array_position(p_profile_ids, null) is not null then
    raise exception using errcode = '22023', message = 'Selecione pelo menos um perfil válido.';
  end if;
  if p_interval_minutes is null or p_interval_minutes < 1 or p_duration_days is null or p_duration_days < 1 then
    raise exception using errcode = '22023', message = 'Intervalo e duração precisam ser positivos.';
  end if;
  if p_format not in ('image', 'reel', 'story') then
    raise exception using errcode = '22023', message = 'Formato inválido para programação em massa.';
  end if;

  resolved_slots := trunc((p_duration_days::numeric * 1440::numeric) / p_interval_minutes::numeric);
  if resolved_slots < 1 or resolved_slots > 9223372036854775807::numeric then
    raise exception using errcode = '22003', message = 'Quantidade de slots não cabe em bigint.';
  end if;
  select count(*)::bigint into requested_profile_count from (select distinct value from unnest(p_profile_ids) as input(value)) requested;
  select count(*)::bigint into online_profile_count from (select distinct value from unnest(p_profile_ids) as input(value)) requested join public.instagram_profiles profile_row on profile_row.id = requested.value where profile_row.organization_id = p_organization_id and profile_row.deleted_at is null and profile_row.status = 'online';
  if requested_profile_count <> online_profile_count then
    raise exception using errcode = 'P0001', message = 'O conjunto de perfis mudou; atualize a seleção antes de revisar.';
  end if;
  resolved_expected := requested_profile_count::numeric * resolved_slots;
  if resolved_expected > 9223372036854775807::numeric then raise exception using errcode = '22003', message = 'Projeção total não cabe em bigint.'; end if;

  with requested as (
    select distinct value as profile_id from unnest(p_profile_ids) as input(value)
  ), profile_bases as (
    select requested.profile_id, greatest(
      resolved_now,
      coalesce((select max(item.execute_at) from public.publication_items item where item.organization_id = p_organization_id and item.profile_id = requested.profile_id and item.format = p_format and item.status in ('waiting', 'ready', 'preparing', 'publishing') and item.execute_at is not null), resolved_now),
      coalesce((select max(horizon.reserved_through) from public.bulk_publication_profile_horizons horizon join public.bulk_publication_plans horizon_plan on horizon_plan.id = horizon.plan_id where horizon.organization_id = p_organization_id and horizon.profile_id = requested.profile_id and horizon.status = 'active' and horizon_plan.format = p_format), resolved_now)
    ) as schedule_base from requested
  ) select min(schedule_base + ((p_interval_minutes::text || ' minutes')::interval)), max(schedule_base + (((resolved_slots * p_interval_minutes::numeric)::text || ' minutes')::interval)) into sample_first_execute_at, sample_last_execute_at from profile_bases;

  return jsonb_build_object('profileCount', online_profile_count::text, 'slotsPerProfile', resolved_slots::bigint::text, 'expectedPublications', resolved_expected::bigint::text, 'firstExecuteAt', sample_first_execute_at, 'lastExecuteAt', sample_last_execute_at, 'reviewedAt', resolved_now);
end;
$$;

revoke all on function public.review_bulk_rotation_schedule(uuid, uuid[], integer, bigint, public.publication_format, timestamptz) from public, anon;
grant execute on function public.review_bulk_rotation_schedule(uuid, uuid[], integer, bigint, public.publication_format, timestamptz) to authenticated, service_role;
notify pgrst, 'reload schema';
