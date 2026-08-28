begin;
select '1..4';

select case when to_regprocedure('public.ignore_expired_unstarted_publication_leases(timestamptz,integer,text)') is not null
  then 'ok 1 - limpeza de lease existe' else 'not ok 1 - limpeza ausente' end;

do $$ declare definition text; begin
  definition := lower(pg_get_functiondef(
    'public.ignore_expired_unstarted_publication_leases(timestamptz,integer,text)'::regprocedure
  ));
  if position('item.creation_id is null' in definition) = 0
    or position('item.lease_until is not null and item.lease_until <= decided_at' in definition) = 0 then
    raise exception 'Criação aceita ou lease ativo pode entrar no escopo.';
  end if;
end $$;
select 'ok 2 - exige criação ausente e lease expirado';

do $$ declare definition text; begin
  definition := lower(pg_get_functiondef(
    'public.ignore_expired_unstarted_publication_leases(timestamptz,integer,text)'::regprocedure
  ));
  if position('candidate_count <> p_expected' in definition) = 0
    or position('item.status in (''preparing'', ''publishing'')' in definition) = 0 then
    raise exception 'Escopo/cardinalidade não são estritos.';
  end if;
end $$;
select 'ok 3 - estado e cardinalidade são estritos';

do $$ declare definition text; begin
  definition := lower(pg_get_functiondef(
    'public.ignore_expired_unstarted_publication_leases(timestamptz,integer,text)'::regprocedure
  ));
  if position('log_publication_item_event' in definition) = 0
    or position('sync_publication_batch_status' in definition) = 0 then
    raise exception 'Auditoria ou lote não são sincronizados.';
  end if;
end $$;
select 'ok 4 - decisão é auditada e lote sincronizado';

rollback;
