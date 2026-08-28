begin;
select plan(4);

select has_function(
  'public', 'claim_single_paused_publication_canary', array['uuid', 'text', 'integer'],
  'claim explícito de canário existe'
);

select ok((
  select pg_get_functiondef(procedure.oid)
  from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public' and procedure.proname = 'claim_single_paused_publication_canary'
) ilike '%item.creation_id is null%',
  'canário nunca recria item aceito pelo provedor'
);

select ok((
  select pg_get_functiondef(procedure.oid)
  from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public' and procedure.proname = 'claim_single_paused_publication_canary'
) ilike '%breaker.paused_at is not null%',
  'canário só opera dentro de lote ainda pausado'
);

select ok(not has_function_privilege(
  'authenticated',
  'public.claim_single_paused_publication_canary(uuid,text,integer)',
  'EXECUTE'
), 'usuário autenticado não pode executar o canário');

select * from finish();
rollback;
