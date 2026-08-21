-- Teste estrutural e transacional. Executar somente em banco local descartável
-- com migrations até 143. Não consulta nem altera produção.
begin;

do $$
declare
  function_definition text;
begin
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'zernio_oauth_turns'
      and indexname = 'zernio_oauth_turns_one_active_profile_idx'
      and indexdef ilike '%where (status = ''active''%'
  ) then raise exception 'Índice parcial de apenas um turno ativo ausente.'; end if;

  select pg_get_functiondef(procedure.oid) into function_definition
  from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public' and procedure.proname = 'maintain_zernio_oauth_turn_queue' limit 1;

  if position('order by turn.created_at, turn.id' in lower(function_definition)) = 0 then
    raise exception 'A promoção precisa preservar FIFO estável.';
  end if;
  if position('active_lease_expired' in lower(function_definition)) = 0
     or position('oauth_turn_expired' in lower(function_definition)) = 0 then
    raise exception 'Expiração precisa encerrar turno e liberar a reserva.';
  end if;
  if position('slot_reservation_expired' in lower(function_definition)) = 0 then
    raise exception 'Turno em espera não pode sobreviver à própria reserva.';
  end if;
  if position('zernio_profile_id = trim(p_zernio_profile_id)' in lower(function_definition)) = 0 then
    raise exception 'A manutenção precisa estar isolada por profile Zernio.';
  end if;

  select pg_get_functiondef(procedure.oid) into function_definition
  from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public' and procedure.proname = 'enqueue_zernio_oauth_turn' limit 1;
  if position('connection.zernio_profile_id = trim(p_zernio_profile_id)' in lower(function_definition)) = 0 then
    raise exception 'Enfileiramento precisa validar o profile canônico da conexão.';
  end if;
  if position('reservation.zernio_connection_id = p_zernio_connection_id' in lower(function_definition)) = 0 then
    raise exception 'Enfileiramento precisa isolar a reserva pela conexão correta.';
  end if;
  if position('insert into public.zernio_oauth_turns' in lower(function_definition)) = 0
     or position('maintain_zernio_oauth_turn_queue' in lower(function_definition))
        < position('insert into public.zernio_oauth_turns' in lower(function_definition)) then
    raise exception 'O primeiro turno precisa ser inserido antes da promoção da fila.';
  end if;

  select pg_get_functiondef(procedure.oid) into function_definition
  from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public' and procedure.proname = 'finish_zernio_oauth_turn' limit 1;
  if position('created_by = p_created_by' in lower(function_definition)) = 0
     or position('attempt_id = p_attempt_id' in lower(function_definition)) = 0 then
    raise exception 'Finalização precisa pertencer ao usuário e attempt do turno.';
  end if;

  if has_function_privilege('authenticated', 'public.enqueue_zernio_oauth_turn(uuid, uuid, text, uuid, uuid, uuid, integer)', 'EXECUTE') then
    raise exception 'Authenticated não deve controlar diretamente a fila.';
  end if;
  if not has_function_privilege('service_role', 'public.finish_zernio_oauth_turn(uuid, uuid, uuid, uuid, text, text)', 'EXECUTE') then
    raise exception 'Service role precisa finalizar e promover turnos.';
  end if;
end;
$$;

rollback;
