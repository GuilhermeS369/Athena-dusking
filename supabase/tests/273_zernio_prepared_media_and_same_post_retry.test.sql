begin;

do $$
declare
  definition text;
begin
  if to_regclass('public.zernio_prepared_media') is null then
    raise exception 'zernio_prepared_media ausente';
  end if;
  if not exists (
    select 1 from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public' and procedure.proname = 'acquire_zernio_prepared_media'
  ) then
    raise exception 'acquire_zernio_prepared_media ausente';
  end if;
  if not exists (
    select 1 from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public' and procedure.proname = 'complete_zernio_prepared_media'
  ) then
    raise exception 'complete_zernio_prepared_media ausente';
  end if;
  if not exists (
    select 1 from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public' and procedure.proname = 'reset_due_zernio_media_preparation'
  ) then
    raise exception 'reset_due_zernio_media_preparation ausente';
  end if;

  select pg_get_functiondef(procedure.oid) into definition
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public' and procedure.proname = 'reserve_zernio_same_post_media_retry';

  if definition is null then
    raise exception 'reserve_zernio_same_post_media_retry ausente';
  end if;
  if definition not ilike '%zernio_recovery_count = 1%' then
    raise exception 'retry no mesmo post não possui trava de uso único';
  end if;
  if definition ilike '%creation_id = null%' or definition ilike '%creation_id = NULL%' then
    raise exception 'retry no mesmo post não pode limpar creation_id';
  end if;
  if has_function_privilege('authenticated', 'public.reserve_zernio_same_post_media_retry(uuid,text,text,text,text,integer)', 'EXECUTE') then
    raise exception 'authenticated não pode reservar retry externo';
  end if;
  if not has_function_privilege('service_role', 'public.reserve_zernio_same_post_media_retry(uuid,text,text,text,text,integer)', 'EXECUTE') then
    raise exception 'service_role precisa executar retry seguro';
  end if;
end;
$$;

rollback;
