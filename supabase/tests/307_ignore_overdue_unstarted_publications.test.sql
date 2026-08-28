begin;
select '1..4';

select case when to_regprocedure('public.ignore_overdue_unstarted_publications(timestamptz,integer,text)') is not null
  then 'ok 1 - encerramento paginado existe' else 'not ok 1 - função ausente' end;

do $$ declare definition text; begin
  definition := pg_get_functiondef(
    'public.ignore_overdue_unstarted_publications(timestamptz,integer,text)'::regprocedure
  );
  if position('item.creation_id is null' in definition) = 0 then
    raise exception 'Função pode tocar em criação aceita pelo provedor.';
  end if;
end $$;
select 'ok 2 - criação aceita pelo provedor é excluída do escopo';

do $$ declare definition text; begin
  definition := pg_get_functiondef(
    'public.ignore_overdue_unstarted_publications(timestamptz,integer,text)'::regprocedure
  );
  if position('limit p_limit' in definition) = 0 or position('for update skip locked' in definition) = 0 then
    raise exception 'Encerramento não é paginado/concorrente.';
  end if;
end $$;
select 'ok 3 - encerramento usa página curta e skip locked';

do $$ declare definition text; begin
  definition := pg_get_functiondef(
    'public.ignore_overdue_unstarted_publications(timestamptz,integer,text)'::regprocedure
  );
  if position('publication_profile_daily_reservations' in definition) = 0
    or position('publication_dispatch_rate_reservations' in definition) = 0
    or position('log_publication_item_event' in definition) = 0 then
    raise exception 'Reservas ou auditoria não são tratadas.';
  end if;
end $$;
select 'ok 4 - reservas são liberadas e decisão é auditada';

rollback;
