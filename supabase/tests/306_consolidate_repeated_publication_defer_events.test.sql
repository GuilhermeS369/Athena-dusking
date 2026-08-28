begin;

select '1..3';

select case when to_regprocedure('public.defer_publication_item(uuid,text,text,integer,boolean)') is not null
  then 'ok 1 - defer autoritativo continua disponível'
  else 'not ok 1 - defer ausente' end;

do $$ declare definition text; begin
  definition := pg_get_functiondef(
    'public.defer_publication_item(uuid,text,text,integer,boolean)'::regprocedure
  );
  if position('item.container_poll_count + 1' in definition) = 0
    or position('next_attempt_at = now_at + make_interval' in definition) = 0 then
    raise exception 'Estado autoritativo do polling não foi preservado.';
  end if;
end $$;
select 'ok 2 - contador e próxima tentativa continuam atualizados em todo poll';

do $$ declare definition text; begin
  definition := pg_get_functiondef(
    'public.defer_publication_item(uuid,text,text,integer,boolean)'::regprocedure
  );
  if position('updated_row.container_poll_count % 5 = 0' in definition) = 0 then
    raise exception 'Consolidação a cada cinco polls ausente.';
  end if;
end $$;
select 'ok 3 - evento redundante é consolidado a cada cinco polls';

rollback;
