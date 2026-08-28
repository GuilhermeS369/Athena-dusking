begin;
select plan(3);

select has_function(
  'public', 'resume_publication_batch_preserving_items', array['uuid', 'uuid', 'text'],
  'retomada preservando itens existe'
);

select ok((
  select pg_get_functiondef(procedure.oid)
  from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public' and procedure.proname = 'resume_publication_batch_preserving_items'
) not ilike '%update public.publication_items%',
  'retomada não reescreve status nem horário de item'
);

select ok(not has_function_privilege(
  'authenticated',
  'public.resume_publication_batch_preserving_items(uuid,uuid,text)',
  'EXECUTE'
), 'retomada operacional não é exposta ao usuário autenticado');

select * from finish();
rollback;
