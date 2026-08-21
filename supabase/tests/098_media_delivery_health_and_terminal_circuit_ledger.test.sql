-- Teste estrutural da proteção contra mídia indisponível e do circuito terminal.
-- Executar em banco descartável após a migration 098.

begin;

do $$
declare
  function_definition text;
  trigger_definition text;
begin
  if not exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'media_asset_delivery_health') then
    raise exception 'Tabela de saúde da mídia não encontrada.';
  end if;
  if not exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'media_asset_delivery_attempts') then
    raise exception 'Tabela de tentativas de entrega de mídia não encontrada.';
  end if;
  if not exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'publication_batch_terminal_outcomes') then
    raise exception 'Ledger terminal por publicação não encontrado.';
  end if;

  if not exists (
    select 1 from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname = 'record_media_asset_delivery_attempt'
      and pg_get_function_identity_arguments(procedure.oid) = 'p_media_asset_id uuid, p_publication_item_id uuid, p_provider text, p_phase text, p_outcome text, p_error_code text, p_error_message text, p_url_fingerprint text'
  ) then
    raise exception 'RPC de tentativa de entrega de mídia não encontrada.';
  end if;

  select pg_get_functiondef(procedure.oid) into function_definition
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public' and procedure.proname = 'record_media_asset_delivery_attempt'
  limit 1;

  if position('for update' in lower(function_definition)) = 0 then
    raise exception 'A saúde da mídia deve ser serializada com FOR UPDATE.';
  end if;
  if position('consecutive_equivalent_failures >= 2' in lower(function_definition)) = 0 then
    raise exception 'A quarentena precisa exigir duas falhas independentes.';
  end if;
  if position('item.creation_id is null' in lower(function_definition)) = 0 then
    raise exception 'Quarentena não pode tocar item já aceito pelo provedor.';
  end if;

  select pg_get_functiondef(procedure.oid) into trigger_definition
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public' and procedure.proname = 'apply_publication_batch_failure_circuit_breaker'
  limit 1;

  if position('on conflict (publication_item_id) do nothing' in lower(trigger_definition)) = 0 then
    raise exception 'Circuito deve registrar uma única falha terminal por item.';
  end if;
  if position($needle$new.event_type not in ('published', 'failed')$needle$ in lower(trigger_definition)) = 0 then
    raise exception 'Cancelamento não pode zerar o circuito.';
  end if;
  if position($needle$inserted_outcome.outcome = 'published'$needle$ in lower(trigger_definition)) = 0 then
    raise exception 'Somente publicação confirmada pode zerar o circuito.';
  end if;

  if has_function_privilege('authenticated', 'public.record_media_asset_delivery_attempt(uuid, uuid, text, text, text, text, text, text)', 'EXECUTE') then
    raise exception 'Authenticated não deve registrar telemetria interna diretamente.';
  end if;
  if not has_function_privilege('service_role', 'public.record_media_asset_delivery_attempt(uuid, uuid, text, text, text, text, text, text)', 'EXECUTE') then
    raise exception 'Service role precisa registrar telemetria de mídia.';
  end if;
end;
$$;

rollback;
