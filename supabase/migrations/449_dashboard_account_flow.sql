-- Contas plugadas x contas caídas, por dia, para a dashboard.
--
-- Pedido do dono em 14/10/2026, depois da onda de 13/10 (454 quedas por
-- checkpoint em 13 horas): ver, por dia e na organização inteira, quantas contas
-- entraram e quantas caíram — não precisam ser as mesmas contas — e por qual
-- motivo cada uma caiu (190, 25, 100, Zernio...).
--
-- "Plugada" é uma linha nova em instagram_profiles. Conta que cai e é plugada de
-- novo nasce em linha nova (o índice único de identidade só vale para linhas
-- vivas), então ela conta de novo no dia em que voltou — que é o que a operação
-- quer medir. Renovar token de conta viva não cria linha e não conta.
--
-- "Caída" é um incidente em meta_profile_disconnection_incidents ou em
-- zernio_profile_disconnection_incidents, pelo detected_at. Remoção pedida pelo
-- operador (signal = 'operator_requested') não é queda: sai num campo próprio
-- para não inflar a taxa.
--
-- Dia é o de Brasília.
--
-- Leveza: os incidentes já têm (organization_id, detected_at desc) nas duas
-- tabelas. Os perfis só tinham índice por created_at restrito a linhas vivas
-- (deleted_at is null), e a conta caída é justamente a removida — então entra um
-- índice sem predicado. 14 mil linhas em 14/10/2026; criação instantânea, sem
-- CONCURRENTLY (o CLI aplica a migration dentro de transação).

create index if not exists instagram_profiles_org_created_all_idx
  on public.instagram_profiles (organization_id, created_at);

create or replace function public.get_dashboard_account_flow(
  p_organization_id uuid,
  p_start_date date,
  p_end_date date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  window_start timestamptz;
  window_end timestamptz;
  result jsonb;
begin
  if not public.is_service_role_request()
    and not public.is_organization_member(p_organization_id)
  then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  if p_start_date is null or p_end_date is null
    or p_start_date > p_end_date
    or (p_end_date - p_start_date) > 365
  then
    raise exception using errcode = '22023', message = 'Período inválido; use uma janela entre 1 e 366 dias.';
  end if;

  window_start := p_start_date::timestamp at time zone 'America/Sao_Paulo';
  window_end := (p_end_date + 1)::timestamp at time zone 'America/Sao_Paulo';

  with connected as (
    select
      (profile.created_at at time zone 'America/Sao_Paulo')::date as day,
      profile.provider::text as provider
    from public.instagram_profiles as profile
    where profile.organization_id = p_organization_id
      and profile.created_at >= window_start
      and profile.created_at < window_end
  ),
  falls as (
    select
      (incident.detected_at at time zone 'America/Sao_Paulo')::date as day,
      'meta'::text as source,
      incident.signal::text as signal,
      incident.error_code as code,
      incident.error_subcode::text as subcode,
      incident.error_message as message,
      incident.detected_at
    from public.meta_profile_disconnection_incidents as incident
    where incident.organization_id = p_organization_id
      and incident.detected_at >= window_start
      and incident.detected_at < window_end
    union all
    select
      (incident.detected_at at time zone 'America/Sao_Paulo')::date,
      'zernio',
      incident.signal,
      incident.error_code,
      null,
      incident.error_message,
      incident.detected_at
    from public.zernio_profile_disconnection_incidents as incident
    where incident.organization_id = p_organization_id
      and incident.detected_at >= window_start
      and incident.detected_at < window_end
  ),
  days as (
    select generate_series(p_start_date, p_end_date, interval '1 day')::date as day
  ),
  reason_keys as (
    select
      falls.*,
      falls.source || ':' || falls.signal || ':' || coalesce(falls.code, '') || ':' || coalesce(falls.subcode, '') as reason_key,
      falls.signal <> 'operator_requested' as is_fall
    from falls
  ),
  -- Uma agregação por fonte e um join por dia. A primeira versão contava com
  -- subconsulta por dia, e a janela de 90 dias custava 418 ms no ensaio.
  connected_by_day as (
    select
      connected.day,
      count(*) as total,
      count(*) filter (where connected.provider = 'meta_official') as meta,
      count(*) filter (where connected.provider = 'zernio') as zernio
    from connected
    group by connected.day
  ),
  falls_by_day as (
    select
      reason_keys.day,
      count(*) filter (where reason_keys.is_fall) as fallen,
      count(*) filter (where not reason_keys.is_fall) as removed
    from reason_keys
    group by reason_keys.day
  ),
  reasons_by_day as (
    select grouped.day, jsonb_object_agg(grouped.reason_key, grouped.total) as by_reason
    from (
      select reason_keys.day, reason_keys.reason_key, count(*) as total
      from reason_keys
      group by reason_keys.day, reason_keys.reason_key
    ) as grouped
    group by grouped.day
  ),
  per_day as (
    select
      days.day,
      coalesce(connected_by_day.total, 0) as connected,
      coalesce(connected_by_day.meta, 0) as connected_meta,
      coalesce(connected_by_day.zernio, 0) as connected_zernio,
      coalesce(falls_by_day.fallen, 0) as fallen,
      coalesce(falls_by_day.removed, 0) as removed,
      coalesce(reasons_by_day.by_reason, '{}'::jsonb) as by_reason
    from days
    left join connected_by_day on connected_by_day.day = days.day
    left join falls_by_day on falls_by_day.day = days.day
    left join reasons_by_day on reasons_by_day.day = days.day
  ),
  reasons as (
    select
      reason_keys.reason_key,
      min(reason_keys.source) as source,
      min(reason_keys.signal) as signal,
      min(reason_keys.code) as code,
      min(reason_keys.subcode) as subcode,
      bool_and(reason_keys.is_fall) as is_fall,
      count(*) as total,
      (array_agg(reason_keys.message order by reason_keys.detected_at desc) filter (where reason_keys.message is not null))[1] as sample_message,
      max(reason_keys.detected_at) as last_at
    from reason_keys
    group by reason_keys.reason_key
  )
  select jsonb_build_object(
    'start_date', p_start_date,
    'end_date', p_end_date,
    'days', coalesce((
      select jsonb_agg(jsonb_build_object(
        'date', per_day.day,
        'connected', per_day.connected,
        'connected_meta', per_day.connected_meta,
        'connected_zernio', per_day.connected_zernio,
        'fallen', per_day.fallen,
        'removed', per_day.removed,
        'by_reason', per_day.by_reason
      ) order by per_day.day)
      from per_day
    ), '[]'::jsonb),
    'reasons', coalesce((
      select jsonb_agg(jsonb_build_object(
        'key', reasons.reason_key,
        'source', reasons.source,
        'signal', reasons.signal,
        'code', reasons.code,
        'subcode', reasons.subcode,
        'is_fall', reasons.is_fall,
        'total', reasons.total,
        'sample_message', left(reasons.sample_message, 240),
        'last_at', reasons.last_at
      ) order by reasons.total desc, reasons.reason_key)
      from reasons
    ), '[]'::jsonb),
    'totals', jsonb_build_object(
      'connected', (select count(*) from connected),
      'fallen', (select count(*) from reason_keys where reason_keys.is_fall),
      'removed', (select count(*) from reason_keys where not reason_keys.is_fall)
    ),
    'online_now', (
      select count(*)
      from public.instagram_profiles as profile
      where profile.organization_id = p_organization_id
        and profile.deleted_at is null
        and profile.status::text = 'online'
    )
  )
  into result;

  return result;
end;
$$;

revoke all on function public.get_dashboard_account_flow(uuid, date, date) from public, anon;
grant execute on function public.get_dashboard_account_flow(uuid, date, date) to authenticated, service_role;
