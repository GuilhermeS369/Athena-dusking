begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(8);

select extensions.has_table('public', 'twitter_provider_usage_reconciliations', 'registro imutável de reconciliação existe');
select extensions.has_function(
  'public', 'twitter_reconcile_provider_usage',
  array['uuid','uuid','uuid','date','twitter_price_category','integer','integer','integer','bigint','text','jsonb','text','uuid','text'],
  'RPC atômica de reconciliação existe'
);
select extensions.function_privs_are(
  'public', 'twitter_reconcile_provider_usage',
  array['uuid','uuid','uuid','date','twitter_price_category','integer','integer','integer','bigint','text','jsonb','text','uuid','text'],
  'service_role', array['EXECUTE'], 'somente service_role executa a RPC'
);
select extensions.results_eq(
  $$select count(*)::bigint from pg_trigger where tgrelid='public.twitter_provider_usage_reconciliations'::regclass and tgname='twitter_provider_usage_reconciliations_immutable'$$,
  array[1::bigint], 'registro é imutável'
);
select extensions.results_eq(
  $$select count(*)::bigint from pg_constraint where conrelid='public.twitter_provider_usage_reconciliations'::regclass and contype='u'$$,
  array[2::bigint], 'idempotência e snapshot observado possuem unicidade'
);
select extensions.results_eq(
  $$select count(*)::bigint from pg_policies where schemaname='public' and tablename='twitter_provider_usage_reconciliations'$$,
  array[1::bigint], 'RLS organizacional possui uma política de leitura'
);
select extensions.results_eq(
  $$select count(*)::bigint from pg_proc where pronamespace='public'::regnamespace and proname='twitter_reconcile_provider_usage' and prosecdef$$,
  array[1::bigint], 'RPC usa security definer'
);
select extensions.results_eq(
  $$select count(*)::bigint from pg_proc where pronamespace='public'::regnamespace and proname='twitter_reconcile_provider_usage' and prosrc ilike '%provider-usage-debit:%' and prosrc ilike '%posted_balance_micros = posted_balance_micros - amount%'$$,
  array[1::bigint], 'ledger e carteira são atualizados na mesma transação'
);

select * from extensions.finish();
rollback;

