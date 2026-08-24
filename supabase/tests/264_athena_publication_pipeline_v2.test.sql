begin;

select plan(8);

select has_column('public', 'publication_items', 'pipeline_version',
  'publication_items possui versão explícita da esteira');
select has_column('public', 'publication_items', 'preparation_status',
  'publication_items possui estado de preparação local');
select has_table('public', 'publication_dispatch_sla_alerts',
  'alertas de atraso v2 são persistidos separadamente');

select ok(not exists (
  select 1 from public.publication_items
  where pipeline_version = 2 and status in ('waiting', 'ready')
    and pipeline_migrated_at is not null and execute_at < pipeline_migrated_at - interval '120 seconds'
), 'nenhum item anterior à janela operacional do corte foi migrado para v2');

select ok((
  select pg_get_functiondef(procedure.oid)
  from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public' and procedure.proname = 'claim_publication_preparation_items'
) ilike '%make_interval(hours => p_window_hours)%for update of item skip locked%',
  'preparação usa janela dinâmica e lease concorrente');

select ok((
  select pg_get_functiondef(procedure.oid)
  from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public' and procedure.proname = 'claim_publication_items'
    and pg_get_function_identity_arguments(procedure.oid) = 'p_worker_id text, p_limit integer, p_lease_seconds integer'
) ilike '%preparation_status = ''ready''%'
  and (
    select pg_get_functiondef(procedure.oid)
    from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public' and procedure.proname = 'claim_publication_items'
      and pg_get_function_identity_arguments(procedure.oid) = 'p_worker_id text, p_limit integer, p_lease_seconds integer'
  ) ilike '%creation_id is not null%'
  and (
    select pg_get_functiondef(procedure.oid)
    from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public' and procedure.proname = 'claim_publication_items'
      and pg_get_function_identity_arguments(procedure.oid) = 'p_worker_id text, p_limit integer, p_lease_seconds integer'
  ) ilike '%pipeline_version = 1%'
  and (
    select pg_get_functiondef(procedure.oid)
    from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public' and procedure.proname = 'claim_publication_items'
      and pg_get_function_identity_arguments(procedure.oid) = 'p_worker_id text, p_limit integer, p_lease_seconds integer'
  ) ilike '%for update of item skip locked%',
  'claim preserva preparação, reconciliação, corte legado e SKIP LOCKED');

select ok((
  select pg_get_functiondef(procedure.oid)
  from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public' and procedure.proname = 'recover_missed_publication_slots'
    and pg_get_function_identity_arguments(procedure.oid) = 'p_max_items integer, p_grace_seconds integer, p_worker_id text, p_cycle_correlation_id uuid'
) ilike '%pipeline_version = 2%'
  and (
    select pg_get_functiondef(procedure.oid)
    from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public' and procedure.proname = 'recover_missed_publication_slots'
      and pg_get_function_identity_arguments(procedure.oid) = 'p_max_items integer, p_grace_seconds integer, p_worker_id text, p_cycle_correlation_id uuid'
  ) ilike '%overdue_sla_alerted%'
  and (
    select pg_get_functiondef(procedure.oid)
    from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public' and procedure.proname = 'recover_missed_publication_slots'
      and pg_get_function_identity_arguments(procedure.oid) = 'p_max_items integer, p_grace_seconds integer, p_worker_id text, p_cycle_correlation_id uuid'
  ) ilike '%publication_dispatch_sla_alerts%'
  and (
    select pg_get_functiondef(procedure.oid)
    from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public' and procedure.proname = 'recover_missed_publication_slots'
      and pg_get_function_identity_arguments(procedure.oid) = 'p_max_items integer, p_grace_seconds integer, p_worker_id text, p_cycle_correlation_id uuid'
  ) ilike '%pipeline_version = 1%',
  '120 segundos gera SLA em v2 e mantém corte separado para legado');

select ok((
  select pg_get_functiondef(procedure.oid)
  from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public' and procedure.proname = 'claim_publication_preparation_items'
) not ilike '%zernio%',
  'preparação SQL não agenda nem chama Zernio');

select * from finish();
rollback;
