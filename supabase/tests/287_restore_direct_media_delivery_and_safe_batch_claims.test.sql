begin;
select plan(8);

select has_function(
  'public', 'is_publication_duplicate_content_failure', array['text', 'text'],
  'classificador de duplicidade existe'
);

select ok(
  public.is_publication_duplicate_content_failure('duplicate_content_detected', null),
  'código explícito de duplicidade é reconhecido'
);

select ok(
  public.is_publication_duplicate_content_failure('user_content', 'Duplicate content detected. This identical content was already published.'),
  'mensagem explícita da Zernio é reconhecida mesmo com código genérico'
);

select ok(
  not public.is_publication_duplicate_content_failure('platform_error', 'Instagram could not download the media URL.'),
  'falha de leitura não é confundida com duplicidade'
);

select ok((
  select pg_get_functiondef(procedure.oid)
  from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public' and procedure.proname = 'apply_publication_batch_failure_circuit_breaker'
) ilike '%is_publication_duplicate_content_failure%',
  'duplicidade não alimenta o circuit breaker do lote'
);

select ok((
  select pg_get_functiondef(procedure.oid)
  from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public' and procedure.proname = 'claim_publication_items'
) ilike '%item.creation_id is not null%or not exists%',
  'creation_id ignora pausa do lote somente para reconciliação'
);

select has_table('public', 'zernio_prepared_media',
  'cache legado permanece disponível durante rollout sem remoção destrutiva');

select ok((
  select pg_get_functiondef(procedure.oid)
  from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname = 'project_publication_event_to_instagram_observability'
) ilike '%exception when others%'
  and (
    select pg_get_functiondef(procedure.oid)
    from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname = 'project_publication_event_to_instagram_observability'
  ) ilike '%::public.instagram_observability_severity%',
  'observabilidade permanece tipada e best-effort'
);

select * from finish();
rollback;
