-- Contrato estrutural da exclusão total local. O cenário transacional completo
-- requer fixtures de auth/organização e roda no banco descartável de integração.

begin;

do $$
begin
  if to_regclass('public.zernio_connection_total_deletion_operations') is null then
    raise exception 'tabela de operações de exclusão total Zernio não foi criada';
  end if;
  if to_regprocedure('public.begin_zernio_connection_total_deletion(uuid,text)') is null then
    raise exception 'RPC de início da exclusão total Zernio não foi criada';
  end if;
  if to_regprocedure('public.execute_zernio_connection_total_deletion(uuid)') is null then
    raise exception 'RPC de execução da exclusão total Zernio não foi criada';
  end if;
end;
$$;

-- O código da migration deve continuar estritamente local: a operação somente
-- chama RPCs de banco e não depende de endpoint, URL ou cliente da Zernio.
do $$
declare
  definition text;
begin
  select pg_get_functiondef('public.execute_zernio_connection_total_deletion(uuid)'::regprocedure)
  into definition;
  if definition ilike '%http%' or definition ilike '%disconnectaccount%' then
    raise exception 'a exclusão total local não pode conter chamada remota';
  end if;
end;
$$;

rollback;
