begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(1);

do $$
declare function_definition text;
begin
  select pg_get_functiondef(procedure.oid) into function_definition
  from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public' and procedure.proname = 'maintain_zernio_oauth_turn_queue' limit 1;
  if position('zernio-oauth-connection:' in function_definition) = 0 then
    raise exception 'A fila OAuth precisa ser serializada por conexão antes do redirect.';
  end if;
  if position('zernio_connection_id = target_connection_id' in function_definition) = 0 then
    raise exception 'A promoção FIFO precisa permanecer no escopo da conexão.';
  end if;
end $$;

do $$
declare function_definition text;
begin
  select pg_get_functiondef(procedure.oid) into function_definition
  from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public' and procedure.proname = 'reconcile_zernio_connection_accounts' limit 1;
  if position('resolution = ''reassociated''' in function_definition) = 0
     or position('tombstone_immutable_id = immutable_instagram_id' in function_definition) = 0
     or position('tombstone_immutable_id is null' in function_definition) = 0 then
    raise exception 'Tombstone só pode liberar reassociação com identidade imutável comprovada.';
  end if;
end $$;

do $$
declare index_definition text;
begin
  select indexdef into index_definition from pg_indexes
  where schemaname = 'public' and indexname = 'zernio_oauth_turns_one_active_connection_idx';
  if index_definition is null or position('(organization_id, zernio_connection_id)' in index_definition) = 0 then
    raise exception 'Deve existir somente um OAuth ativo por conexão.';
  end if;
end $$;

do $$
declare index_definition text;
begin
  select indexdef into index_definition from pg_indexes
  where schemaname = 'public' and indexname = 'zernio_addition_claims_one_current_account_idx';
  if index_definition is null or position('WHERE (superseded_at IS NULL)' in index_definition) = 0 then
    raise exception 'Deve existir somente um claim corrente para cada accountId.';
  end if;
end $$;

do $$
declare function_definition text;
begin
  select pg_get_functiondef(procedure.oid) into function_definition
  from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname = 'claim_zernio_oauth_turn_preparation'
    and procedure.pronargs = 4;
  if position('reserve_zernio_connection_slot' in function_definition) > 0
     or position('reservation_id := null' in function_definition) = 0 then
    raise exception 'A preparação pré-OAuth não pode reservar slot nem fazer fallback de conexão.';
  end if;

  if exists (
    select 1 from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname = 'claim_zernio_addition_account'
      and procedure.pronargs = 4
  ) then
    raise exception 'A assinatura antiga do claim não pode permanecer acessível.';
  end if;
  if exists (
    select 1 from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname = 'reserve_zernio_addition_finalization_slot'
      and procedure.pronargs = 3
  ) then
    raise exception 'A reserva antiga sem accountId selecionado não pode permanecer acessível.';
  end if;

  select pg_get_functiondef(procedure.oid) into function_definition
  from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname = 'claim_zernio_addition_account'
    and procedure.pronargs = 7;
  if position('pg_advisory_xact_lock' in function_definition) = 0
     or position('superseded_by_attempt_id = selected.id' in function_definition) = 0
     or position('previous.status not in (''synced'', ''empty'', ''failed'')' in function_definition) = 0
     or position('identity_resolution <> ''reassociated''' in function_definition) = 0 then
    raise exception 'A troca de claim precisa ser exclusiva, terminal, comprovada e auditável.';
  end if;
end $$;

do $$
declare function_definition text;
begin
  select pg_get_functiondef(procedure.oid) into function_definition
  from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname = 'reserve_zernio_addition_finalization_slot'
    and procedure.pronargs = 4;
  if position('account_claim.superseded_at is null' in function_definition) = 0
     or position('- replacing_active_count' in function_definition) = 0
     or position('selected.zernio_connection_id' in function_definition) = 0 then
    raise exception 'A reserva final deve validar claim corrente, replacement e conexão autorizada.';
  end if;
end $$;

do $$
begin
  if not has_function_privilege(
    'service_role',
    'public.claim_zernio_addition_account(uuid, text, text, text, text, text, text)',
    'EXECUTE'
  ) then
    raise exception 'Somente o worker precisa executar o claim com identidade remota.';
  end if;
  if has_function_privilege(
    'authenticated',
    'public.claim_zernio_addition_account(uuid, text, text, text, text, text, text)',
    'EXECUTE'
  ) then
    raise exception 'Usuário autenticado não pode reivindicar accountId.';
  end if;
end $$;

select extensions.pass('FIFO por conexão, claims correntes e reassociação protegida estão estruturados');
select * from extensions.finish();

rollback;
