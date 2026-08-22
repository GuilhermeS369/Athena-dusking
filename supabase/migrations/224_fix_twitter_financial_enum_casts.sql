-- Correção forward-only da migration 223: CASE em PL/pgSQL precisa tipar enums explicitamente.

create or replace function public.twitter_release_wallet_reservation(
  p_reservation_id uuid,
  p_idempotency_key text,
  p_reason text,
  p_manual_resolution boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  reservation_row public.twitter_wallet_reservations;
  wallet_row public.twitter_wallets;
  released_amount bigint;
begin
  select * into reservation_row
  from public.twitter_wallet_reservations
  where id = p_reservation_id
  for update;
  if not found then raise exception using errcode = 'P0002', message = 'Reserva não encontrada.'; end if;

  if coalesce(auth.role(), '') <> 'service_role'
    and not public.has_organization_role(reservation_row.organization_id, array['admin', 'operator']::public.organization_role[])
  then
    raise exception using errcode = '42501', message = 'Sem permissão para liberar a reserva.';
  end if;
  if char_length(trim(coalesce(p_reason, ''))) < 3
    or char_length(trim(coalesce(p_idempotency_key, ''))) not between 8 and 255
  then
    raise exception using errcode = '22023', message = 'Motivo e idempotency key são obrigatórios.';
  end if;
  if reservation_row.status = 'outcome_unknown' and not p_manual_resolution then
    raise exception using errcode = '55000', message = 'Resultado desconhecido exige resolução manual explícita.';
  end if;

  if exists (select 1 from public.twitter_reservation_events where idempotency_key = trim(p_idempotency_key)) then
    return jsonb_build_object('reservationId', reservation_row.id, 'idempotentReplay', true, 'releasedMicros', 0, 'status', reservation_row.status);
  end if;

  released_amount := reservation_row.remaining_micros;
  if released_amount = 0 then
    insert into public.twitter_reservation_events (
      reservation_id, organization_id, event_type, amount_micros, idempotency_key,
      actor_user_id, actor_email, reason
    ) values (
      reservation_row.id, reservation_row.organization_id,
      case
        when p_manual_resolution then 'manual_resolution'::public.twitter_reservation_event_type
        else 'released'::public.twitter_reservation_event_type
      end,
      0, trim(p_idempotency_key), auth.uid(), nullif(auth.jwt() ->> 'email', ''), trim(p_reason)
    );
    return jsonb_build_object('reservationId', reservation_row.id, 'idempotentReplay', false, 'releasedMicros', 0, 'status', reservation_row.status);
  end if;

  select * into wallet_row from public.twitter_wallets
  where identity_id = reservation_row.identity_id for update;
  if wallet_row.reserved_micros < released_amount then
    raise exception using errcode = '55000', message = 'Invariante de saldo reservado violada.';
  end if;

  update public.twitter_wallet_reservations
  set remaining_micros = 0,
      released_micros = released_micros + released_amount,
      status = 'released',
      outcome_unknown_at = null,
      resolved_at = timezone('utc', now()),
      resolution_reason = trim(p_reason)
  where id = reservation_row.id
  returning * into reservation_row;

  update public.twitter_wallets
  set reserved_micros = reserved_micros - released_amount,
      version = version + 1
  where identity_id = reservation_row.identity_id
  returning * into wallet_row;

  insert into public.twitter_reservation_events (
    reservation_id, organization_id, event_type, amount_micros, idempotency_key,
    actor_user_id, actor_email, reason
  ) values (
    reservation_row.id, reservation_row.organization_id,
    case
      when p_manual_resolution then 'manual_resolution'::public.twitter_reservation_event_type
      else 'released'::public.twitter_reservation_event_type
    end,
    released_amount, trim(p_idempotency_key), auth.uid(), nullif(auth.jwt() ->> 'email', ''), trim(p_reason)
  );

  return jsonb_build_object(
    'reservationId', reservation_row.id,
    'idempotentReplay', false,
    'releasedMicros', released_amount,
    'walletVersion', wallet_row.version,
    'availableMicros', wallet_row.posted_balance_micros - wallet_row.reserved_micros,
    'status', reservation_row.status
  );
end;
$$;

create or replace function public.twitter_settle_wallet_reservation(
  p_reservation_id uuid,
  p_amount_micros bigint,
  p_idempotency_key text,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  reservation_row public.twitter_wallet_reservations;
  wallet_row public.twitter_wallets;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Apenas service_role pode liquidar uma cobrança externa.';
  end if;
  if p_amount_micros <= 0 or char_length(trim(coalesce(p_idempotency_key, ''))) not between 8 and 255 then
    raise exception using errcode = '22023', message = 'Liquidação inválida.';
  end if;
  if exists (select 1 from public.twitter_wallet_ledger where idempotency_key = trim(p_idempotency_key)) then
    return jsonb_build_object('reservationId', p_reservation_id, 'idempotentReplay', true);
  end if;

  select * into reservation_row from public.twitter_wallet_reservations
  where id = p_reservation_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Reserva não encontrada.'; end if;
  if p_amount_micros > reservation_row.remaining_micros then
    raise exception using errcode = '22003', message = 'Liquidação supera a reserva remanescente.';
  end if;

  select * into wallet_row from public.twitter_wallets
  where identity_id = reservation_row.identity_id for update;
  if wallet_row.posted_balance_micros < p_amount_micros or wallet_row.reserved_micros < p_amount_micros then
    raise exception using errcode = '55000', message = 'Invariante da carteira violada.';
  end if;

  insert into public.twitter_wallet_ledger (
    identity_id, organization_id, connection_id, rate_card_id, category, origin,
    entry_kind, delta_micros, source_id, idempotency_key, actor_email, metadata
  ) values (
    reservation_row.identity_id, reservation_row.organization_id, reservation_row.connection_id,
    reservation_row.rate_card_id, reservation_row.category, reservation_row.origin,
    'debit', -p_amount_micros, reservation_row.source_id, trim(p_idempotency_key),
    nullif(auth.jwt() ->> 'email', ''), coalesce(p_metadata, '{}'::jsonb)
  );

  update public.twitter_wallet_reservations
  set remaining_micros = remaining_micros - p_amount_micros,
      settled_micros = settled_micros + p_amount_micros,
      status = case
        when remaining_micros - p_amount_micros = 0 then 'settled'::public.twitter_reservation_status
        else 'partially_settled'::public.twitter_reservation_status
      end,
      outcome_unknown_at = null,
      resolved_at = case when remaining_micros - p_amount_micros = 0 then timezone('utc', now()) else resolved_at end
  where id = reservation_row.id
  returning * into reservation_row;

  update public.twitter_wallets
  set posted_balance_micros = posted_balance_micros - p_amount_micros,
      reserved_micros = reserved_micros - p_amount_micros,
      version = version + 1
  where identity_id = reservation_row.identity_id
  returning * into wallet_row;

  insert into public.twitter_reservation_events (
    reservation_id, organization_id, event_type, amount_micros, idempotency_key, metadata
  ) values (
    reservation_row.id, reservation_row.organization_id, 'settled', p_amount_micros,
    'settled-event:' || trim(p_idempotency_key), coalesce(p_metadata, '{}'::jsonb)
  );

  return jsonb_build_object(
    'reservationId', reservation_row.id,
    'idempotentReplay', false,
    'settledMicros', p_amount_micros,
    'remainingMicros', reservation_row.remaining_micros,
    'walletVersion', wallet_row.version,
    'postedBalanceMicros', wallet_row.posted_balance_micros,
    'reservedMicros', wallet_row.reserved_micros,
    'status', reservation_row.status
  );
end;
$$;

revoke all on function public.twitter_release_wallet_reservation(uuid, text, text, boolean) from public;
grant execute on function public.twitter_release_wallet_reservation(uuid, text, text, boolean) to authenticated, service_role;
revoke all on function public.twitter_settle_wallet_reservation(uuid, bigint, text, jsonb) from public;
grant execute on function public.twitter_settle_wallet_reservation(uuid, bigint, text, jsonb) to service_role;
