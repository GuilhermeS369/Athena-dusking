-- Teste estrutural transacional da associação pós-conexão Zernio.
-- Executar em banco descartável com schema até a migration 092.

begin;

do $$
declare
  required_column text;
  function_definition text;
begin
  foreach required_column in array array[
    'requested_group_id',
    'requested_group_name',
    'group_assignment_status',
    'group_assigned_profile_ids',
    'group_assignment_error',
    'group_assignment_completed_at'
  ] loop
    if not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'zernio_connection_attempts'
        and column_name = required_column
    ) then
      raise exception 'Coluna obrigatória ausente: %', required_column;
    end if;
  end loop;

  if not exists (
    select 1
    from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname = 'assign_zernio_attempt_profiles_to_group'
      and pg_get_function_identity_arguments(procedure.oid) = 'p_organization_id uuid, p_attempt_id uuid, p_profile_ids uuid[], p_added_by uuid'
  ) then
    raise exception 'Função atômica de associação Zernio não encontrada.';
  end if;

  select pg_get_functiondef(procedure.oid)
  into function_definition
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname = 'assign_zernio_attempt_profiles_to_group'
  limit 1;

  if position('for update' in lower(function_definition)) = 0 then
    raise exception 'A função deve serializar associações simultâneas com FOR UPDATE.';
  end if;

  if position('on conflict (group_id, profile_id) do nothing' in lower(function_definition)) = 0 then
    raise exception 'A função deve ser idempotente para o mesmo perfil e grupo.';
  end if;

  if has_function_privilege('authenticated', 'public.assign_zernio_attempt_profiles_to_group(uuid, uuid, uuid[], uuid)', 'EXECUTE') then
    raise exception 'Authenticated não deve executar diretamente a associação interna.';
  end if;

  if not has_function_privilege('service_role', 'public.assign_zernio_attempt_profiles_to_group(uuid, uuid, uuid[], uuid)', 'EXECUTE') then
    raise exception 'Service role precisa executar a associação interna.';
  end if;
end;
$$;

rollback;
