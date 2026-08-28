begin;

create extension if not exists pgtap with schema extensions;
select plan(7);

select has_index(
  'public', 'publication_items', 'publication_items_provider_accepted_claim_idx',
  'claim aceito possui índice parcial próprio'
);
select has_index(
  'public', 'publication_items', 'publication_items_unstarted_current_claim_idx',
  'claim não iniciado possui índice parcial próprio'
);

select function_returns(
  'public', 'claim_publication_items', array['text', 'integer', 'integer'], 'setof record',
  'assinatura pública do claim é preservada'
);

select ok(
  position('item.archived_at is null' in lower(pg_get_functiondef('public.claim_publication_items(text,integer,integer)'::regprocedure))) > 0,
  'claim exclui linhas arquivadas'
);
select ok(
  position('item.creation_id is not null' in lower(pg_get_functiondef('public.claim_publication_items(text,integer,integer)'::regprocedure))) > 0
    and position('item.creation_id is null' in lower(pg_get_functiondef('public.claim_publication_items(text,integer,integer)'::regprocedure))) > 0,
  'claim separa criações aceitas das ainda não iniciadas'
);
select ok(
  case
    when to_regprocedure('public.claim_publication_dispatch_staging_items(text,integer,integer,integer)') is null
      then position('interval ''60 seconds''' in lower(pg_get_functiondef('public.claim_publication_items(text,integer,integer)'::regprocedure))) > 0
    else position('interval ''60 seconds''' in lower(pg_get_functiondef('public.claim_publication_items(text,integer,integer)'::regprocedure))) = 0
  end,
  'barreira temporal acompanha o dispatcher ativo'
);
select ok(
  position('skip locked' in lower(pg_get_functiondef('public.claim_publication_items(text,integer,integer)'::regprocedure))) > 0,
  'claim continua concorrente e idempotente com skip locked'
);

select * from finish();
rollback;
