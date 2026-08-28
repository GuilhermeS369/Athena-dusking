begin;
select plan(5);

select ok(public.is_publication_non_pausing_failure('42804', null),
  'falha de observabilidade não pausa lote');
select ok(public.is_publication_non_pausing_failure('zernio_creation_outcome_unknown', null),
  'resultado desconhecido não pausa novas contas do lote');
select ok(public.is_publication_non_pausing_failure('zernio_recovery_confirmation_timeout', null),
  'timeout de reconciliação não pausa lote');
select ok(not public.is_publication_non_pausing_failure('user_content', 'Instagram rejected the caption.'),
  'falha terminal real continua protegida pelo circuit breaker');
select ok((
  select pg_get_functiondef(procedure.oid)
  from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public' and procedure.proname = 'apply_publication_batch_failure_circuit_breaker'
) ilike '%is_publication_non_pausing_failure%',
  'trigger usa a classificação consolidada');

select * from finish();
rollback;
