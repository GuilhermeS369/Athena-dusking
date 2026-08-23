begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(10);

select extensions.has_function('public', 'twitter_set_connection_capabilities', array['uuid','uuid','boolean','boolean','uuid','text','text','text'], 'RPC de capabilities existe');
select extensions.function_privs_are('public', 'twitter_set_connection_capabilities', array['uuid','uuid','boolean','boolean','uuid','text','text','text'], 'service_role', array['EXECUTE'], 'somente service_role executa a RPC');
select extensions.col_is_null('public', 'twitter_connection_events', 'idempotency_key', 'idempotency permanece opcional para eventos antigos');
select extensions.results_eq(
  $$select count(*)::bigint from pg_indexes where schemaname='public' and indexname='twitter_connection_events_capability_idempotency_idx'$$,
  array[1::bigint],
  'índice idempotente de capabilities existe'
);
select extensions.results_eq(
  $$select count(*)::bigint from pg_constraint where conrelid='public.twitter_connections'::regclass and conname='twitter_connections_analytics_enabled_check'$$,
  array[0::bigint],
  'analytics não está mais forçado a false pelo schema'
);
select extensions.results_eq(
  $$select count(*)::bigint from pg_constraint where conrelid='public.twitter_connections'::regclass and pg_get_constraintdef(oid) ilike '%inbox_enabled = false%'$$,
  array[1::bigint],
  'Inbox continua proibido no schema'
);
select extensions.results_eq(
  $$select count(*)::bigint from pg_constraint where conrelid='public.twitter_connection_events'::regclass and pg_get_constraintdef(oid) ilike '%capabilities_changed%'$$,
  array[1::bigint],
  'evento auditado de capability é permitido'
);
select extensions.results_eq(
  $$select count(*)::bigint from information_schema.routines where routine_schema='public' and routine_name='twitter_claim_sync_jobs'$$,
  array[1::bigint],
  'claim de sync continua único'
);
select extensions.results_eq(
  $$select count(*)::bigint from information_schema.parameters where specific_schema='public' and specific_name like 'twitter_claim_sync_jobs_%' and parameter_name='analytics_enabled'$$,
  array[1::bigint],
  'claim entrega o estado desejado de Analytics'
);
select extensions.results_eq(
  $$select count(*)::bigint from pg_proc where pronamespace='public'::regnamespace and proname='twitter_set_connection_capabilities' and prosrc ilike '%p_inbox_enabled%' and prosrc ilike '%Inbox X permanece desabilitado%'$$,
  array[1::bigint],
  'RPC rejeita ativação de Inbox'
);

select * from extensions.finish();
rollback;
