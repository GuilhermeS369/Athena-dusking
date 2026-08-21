-- Regressão do contrato durável de cancelamento. Executar após a migration 187
-- em banco descartável; os cenários completos de itens materializados continuam
-- em 167_safe_scoped_publication_queue_cancellation.test.sql.

begin;

do $$
begin
  if to_regclass('public.publication_queue_cancellation_operations') is null then
    raise exception 'tabela de operações duráveis de cancelamento não foi criada';
  end if;
  if to_regprocedure('public.begin_publication_queue_cancellation(text,uuid,text)') is null then
    raise exception 'RPC de início do cancelamento durável não foi criada';
  end if;
  if to_regprocedure('public.execute_publication_queue_cancellation(uuid)') is null then
    raise exception 'RPC de execução do cancelamento durável não foi criada';
  end if;
end;
$$;

rollback;
