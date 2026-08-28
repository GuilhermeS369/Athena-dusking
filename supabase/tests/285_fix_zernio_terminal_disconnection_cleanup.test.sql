begin;

do $$
declare
  projection_definition text;
  anomaly_definition text;
  containment_definition text;
  completion_definition text;
  recovery_definition text;
begin
  select pg_get_functiondef(procedure.oid) into projection_definition
  from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public' and procedure.proname = 'project_zernio_disconnection_to_instagram_observability'
  limit 1;
  if projection_definition not ilike '%exception when others%'
    or projection_definition not ilike '%public.instagram_observability_severity%'
    or projection_definition not ilike '%public.instagram_observability_treatment%' then
    raise exception 'A projeção de desconexão deve tipar enums e permanecer best-effort.';
  end if;

  select pg_get_functiondef(procedure.oid) into anomaly_definition
  from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public' and procedure.proname = 'project_zernio_request_anomaly_to_instagram_observability'
  limit 1;
  if anomaly_definition not ilike '%automatic_profile_removal%'
    or anomaly_definition not ilike '%item.profile_id%'
    or anomaly_definition not ilike '%account_disconnected%auth_expired%' then
    raise exception 'Anomalias terminais precisam identificar o perfil e a remoção automática.';
  end if;

  select pg_get_functiondef(procedure.oid) into containment_definition
  from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public' and procedure.proname = 'contain_zernio_disconnected_profile'
  limit 1;
  if containment_definition not ilike '%status = ''offline''%'
    or containment_definition not ilike '%status = ''ignored''%'
    or containment_definition not ilike '%publication_dispatch_rate_reservations%' then
    raise exception 'A contenção deve bloquear o perfil e retirar toda a fila elegível.';
  end if;

  select pg_get_functiondef(procedure.oid) into completion_definition
  from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public' and procedure.proname = 'complete_zernio_profile_recycling'
  limit 1;
  if completion_definition not ilike '%delete from public.profile_group_members%'
    or completion_definition not ilike '%deleted_at = timezone%'
    or completion_definition not ilike '%already_disconnected_404%' then
    raise exception 'A conclusão deve preservar a exclusão canônica local após DELETE remoto ou 404.';
  end if;

  select pg_get_functiondef(procedure.oid) into recovery_definition
  from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public' and procedure.proname = 'recover_confirmed_zernio_terminal_disconnections'
  limit 1;
  if recovery_definition not ilike '%zernio_publication_request_anomalies%'
    or recovery_definition not ilike '%instagram_observability_events%'
    or recovery_definition not ilike '%account_disconnected%auth_expired%'
    or recovery_definition ilike '%42804%' then
    raise exception 'A recuperação deve confiar somente nos sinais terminais da telemetria Zernio.';
  end if;
end;
$$;

rollback;
