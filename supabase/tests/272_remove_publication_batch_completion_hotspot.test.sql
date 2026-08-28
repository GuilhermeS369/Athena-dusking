begin;

select plan(12);

select has_column('public', 'publication_batch_terminal_outcomes', 'reconciled_at',
  'ledger terminal possui marcador de consolidacao por ciclo');
select has_function('public', 'reconcile_publication_batch_runtime', array['integer'],
  'RPC de consolidacao dos lotes existe');
select has_function('public', 'defer_publication_infrastructure_failure', array['uuid','text','text','text','integer'],
  'RPC de retry de infraestrutura existe');
select has_function('public', 'get_paused_publication_batch_alerts', array['uuid'],
  'resumo leve de lotes pausados existe');

select ok(public.is_publication_infrastructure_error('57014', 'canceling statement due to statement timeout'),
  '57014 e classificado como infraestrutura');
select ok(public.is_publication_infrastructure_error('40001', 'serialization failure'),
  'conflito transacional e classificado como infraestrutura');
select ok(not public.is_publication_infrastructure_error('platform_error', 'Instagram nao baixou a midia'),
  'erro real da plataforma continua fora da classificacao interna');
select ok(not public.is_publication_infrastructure_error('190', 'token invalido'),
  'queda terminal de perfil continua fora da classificacao interna');

select ok((
  select pg_get_functiondef(procedure.oid)
  from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public' and procedure.proname = 'complete_publication_item'
    and pg_get_function_identity_arguments(procedure.oid) =
      'p_item_id uuid, p_worker_id text, p_outcome text, p_meta_media_id text, p_error_code text, p_error_message text, p_retryable boolean, p_max_attempts integer'
) not ilike '%sync_publication_batch_status%',
  'conclusao individual nao atualiza a linha compartilhada do lote');

select ok((
  select pg_get_functiondef(procedure.oid)
  from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public' and procedure.proname = 'apply_publication_batch_failure_circuit_breaker'
) not ilike '%for update%',
  'trigger individual nao trava a linha compartilhada do circuit breaker');

select ok((
  select pg_get_functiondef(procedure.oid)
  from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public' and procedure.proname = 'reconcile_publication_batch_runtime'
) ilike '%pg_try_advisory_xact_lock%'
  and (
    select pg_get_functiondef(procedure.oid)
    from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public' and procedure.proname = 'reconcile_publication_batch_runtime'
  ) ilike '%sync_publication_batch_status%',
  'consolidacao serializa uma vez por lote e sincroniza seu estado fora dos itens');

select ok((
  select pg_get_functiondef(procedure.oid)
  from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public' and procedure.proname = 'get_paused_publication_batch_alerts'
) ilike '%blocked_items%'
  and (
    select pg_get_functiondef(procedure.oid)
    from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public' and procedure.proname = 'get_paused_publication_batch_alerts'
  ) ilike '%paused_at is not null%',
  'alerta retorna somente pausas e quantidade bloqueada');

select * from finish();
rollback;
