begin;

do $$
declare
  claim_definition text;
  resume_definition text;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'zernio_connection_attempts'
      and column_name = 'recovery_deadline_at'
  ) then
    raise exception 'Attempts precisam registrar o prazo máximo da recuperação pós-callback.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'zernio_connection_attempts'
      and column_name = 'recovery_next_attempt_at'
  ) then
    raise exception 'Attempts precisam registrar a próxima consulta remota da recuperação.';
  end if;

  select pg_get_functiondef(procedure.oid) into claim_definition
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname = 'claim_zernio_connection_additions'
  limit 1;
  if claim_definition not ilike '%recovery_next_attempt_at%'
     or claim_definition not ilike '%on conflict on constraint zernio_addition_organization_locks_pkey%' then
    raise exception 'O claim deve respeitar o agendamento da recuperação e preservar o lock FIFO da organização.';
  end if;

  select pg_get_functiondef(procedure.oid) into resume_definition
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname = 'resume_zernio_post_callback_recovery'
  limit 1;
  if resume_definition not ilike '%worker_status = ''recovery_paused''%'
     or resume_definition not ilike '%attempt.created_by = p_created_by%'
     or resume_definition not ilike '%attempt.organization_id = p_organization_id%' then
    raise exception 'A retomada precisa ser limitada ao criador, empresa e estado pausado da tentativa.';
  end if;
end;
$$;

rollback;
