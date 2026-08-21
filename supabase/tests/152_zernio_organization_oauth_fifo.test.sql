begin;

do $$
declare
  index_definition text;
  maintain_definition text;
  enqueue_definition text;
  claim_definition text;
begin
  select indexdef into index_definition
  from pg_indexes
  where schemaname = 'public'
    and indexname = 'zernio_oauth_turns_one_active_organization_idx';
  if index_definition is null
     or index_definition not ilike '%(organization_id)%'
     or index_definition not ilike '%status = ''active''%' then
    raise exception 'A exclusividade OAuth deve ser parcial e por organização.';
  end if;

  select pg_get_functiondef(procedure.oid) into maintain_definition
  from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname = 'maintain_zernio_oauth_turn_queue'
  limit 1;
  if maintain_definition not ilike '%:zernio-oauth-organization%'
     or maintain_definition not ilike '%order by turn.created_at, turn.id%'
     or maintain_definition not ilike '%for update skip locked%' then
    raise exception 'A manutenção deve usar lock da organização e promoção FIFO recuperável.';
  end if;

  select pg_get_functiondef(procedure.oid) into enqueue_definition
  from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public' and procedure.proname = 'enqueue_zernio_oauth_turn'
  limit 1;
  if enqueue_definition not ilike '%p_reservation_id%'
     or enqueue_definition not ilike '%''waiting''%' then
    raise exception 'Enqueue deve aceitar reserva nula e criar item aguardando.';
  end if;

  select pg_get_functiondef(procedure.oid) into claim_definition
  from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public' and procedure.proname = 'claim_zernio_oauth_turn_preparation'
  limit 1;
  if claim_definition not ilike '%reserve_zernio_connection_slot%'
     or claim_definition not ilike '%slotReservedAfterQueuePromotionAt%' then
    raise exception 'A reserva deve acontecer somente após promoção.';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'zernio_oauth_turns'
      and column_name = 'zernio_slot_reservation_id' and is_nullable <> 'YES'
  ) then
    raise exception 'Turnos aguardando precisam aceitar reserva nula.';
  end if;
end;
$$;

rollback;
