begin;

create extension if not exists pgtap with schema extensions;
select plan(16);

select has_column('public', 'publication_items', 'dispatch_staged_by', 'item possui dono do staging');
select has_column('public', 'publication_items', 'dispatch_staged_at', 'item registra início do staging');
select has_column('public', 'publication_items', 'dispatch_staged_until', 'item possui lease de staging');

select has_function(
  'public', 'claim_publication_dispatch_staging_items', array['text', 'integer', 'integer', 'integer'],
  'RPC de staging antecipado existe'
);
select has_function(
  'public', 'activate_staged_publication_items', array['text', 'uuid[]', 'integer'],
  'RPC de ativação no horário existe'
);
select has_function(
  'public', 'release_publication_dispatch_staging', array['text', 'uuid[]'],
  'RPC de liberação do staging existe'
);

select ok(
  position('item.execute_at <= timezone(''utc'', now()) + make_interval' in
    lower(pg_get_functiondef('public.claim_publication_dispatch_staging_items(text,integer,integer,integer)'::regprocedure))) > 0,
  'staging busca somente dentro do horizonte configurado'
);
select ok(
  position('item.execute_at <= timezone(''utc'', now())' in
    lower(pg_get_functiondef('public.activate_staged_publication_items(text,uuid[],integer)'::regprocedure))) > 0,
  'ativação não entrega item antes do horário'
);
select ok(
  position('already_active' in
    lower(pg_get_functiondef('public.activate_staged_publication_items(text,uuid[],integer)'::regprocedure))) > 0,
  'ativação repetida recupera o mesmo claim sem consumir nova tentativa'
);
select ok(
  position('item.dispatch_staged_by is not null' in
    lower(pg_get_functiondef('public.activate_staged_publication_items(text,uuid[],integer)'::regprocedure))) > 0
  and position('item.dispatch_staged_by = trim(p_worker_id)' in
    lower(pg_get_functiondef('public.activate_staged_publication_items(text,uuid[],integer)'::regprocedure))) = 0,
  'restart com novo worker pode recuperar o spool persistido sem aguardar o lease expirar'
);
select ok(
  position('interval ''60 seconds''' in
    lower(pg_get_functiondef('public.claim_publication_items(text,integer,integer)'::regprocedure))) = 0,
  'claim de contingência não descarta backlog interno após 60 segundos'
);
select ok(
  position('publication_slot_risk_incidents' in
    lower(pg_get_functiondef('public.claim_publication_items(text,integer,integer)'::regprocedure))) > 0
  and position('publication_slot_risk_incidents' in
    lower(pg_get_functiondef('public.claim_publication_dispatch_staging_items(text,integer,integer,integer)'::regprocedure))) > 0,
  'claim e staging preservam contenção de slot com risco de duplicidade'
);
select ok(
  position('automatic_expired_unstarted_publication' in
    lower(pg_get_functiondef('public.ignore_overdue_unstarted_publications(timestamptz,integer,text)'::regprocedure))) > 0
  and position('automaticdiscarddisabled' in
    lower(pg_get_functiondef('public.ignore_overdue_unstarted_publications(timestamptz,integer,text)'::regprocedure))) > 0,
  'descarte automático por capacidade interna fica desativado'
);
select ok(
  position('log_publication_item_event' in
    lower(pg_get_functiondef('public.ignore_overdue_unstarted_publications(timestamptz,integer,text)'::regprocedure))) > 0
  and position('explicit_operator_action' in
    lower(pg_get_functiondef('public.ignore_overdue_unstarted_publications(timestamptz,integer,text)'::regprocedure))) > 0,
  'limpeza manual explícita continua auditável'
);
select has_function(
  'public', 'assert_claimed_publication_profile_online', array['uuid', 'text'],
  'revalidação de perfil online imediatamente antes do provedor permanece disponível'
);
select has_function(
  'public', 'schedule_zernio_profile_disconnection', array['uuid', 'text', 'text', 'text', 'text', 'boolean'],
  'contenção e reciclagem de perfil Zernio terminal permanecem disponíveis'
);

select * from finish();
rollback;
