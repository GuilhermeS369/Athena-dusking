begin;
select plan(2);

select function_returns('public', 'get_operational_alerts', array['uuid', 'integer', 'integer', 'integer'], 'setof record',
  'Central Operacional mantém o contrato agregado de alertas');
select ok((
  select pg_get_functiondef(procedure.oid)
  from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public' and procedure.proname = 'get_operational_alerts'
    and pg_get_function_identity_arguments(procedure.oid) = 'p_organization_id uuid, p_stale_after_seconds integer, p_queue_lag_warning_seconds integer, p_async_job_age_warning_seconds integer'
) ilike '%publication_dispatch_sla_alerts%'
  and (
    select pg_get_functiondef(procedure.oid)
    from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public' and procedure.proname = 'get_operational_alerts'
      and pg_get_function_identity_arguments(procedure.oid) = 'p_organization_id uuid, p_stale_after_seconds integer, p_queue_lag_warning_seconds integer, p_async_job_age_warning_seconds integer'
  ) ilike '%continuam elegíveis e não foram descartados%',
  'alerta SLA v2 aparece no painel sem sugerir descarte');

select * from finish();
rollback;
