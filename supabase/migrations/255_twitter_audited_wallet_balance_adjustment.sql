-- Ajuste administrativo auditável de uma carteira X existente.
-- A operação trabalha com saldo-alvo, exige o saldo anterior esperado e é
-- idempotente; nunca altera ou recria a concessão original.

create or replace function public.twitter_set_wallet_balance_admin(
  p_organization_id uuid,
  p_identity_id uuid,
  p_connection_id uuid,
  p_expected_posted_micros bigint,
  p_target_posted_micros bigint,
  p_reason text,
  p_idempotency_key text,
  p_actor_user_id uuid default null,
  p_actor_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  wallet_row public.twitter_wallets;
  delta bigint;
  ledger_row public.twitter_wallet_ledger;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Apenas service_role ajusta saldo administrativo X.';
  end if;
  if p_target_posted_micros < 0
    or char_length(trim(coalesce(p_reason, ''))) < 5
    or char_length(trim(coalesce(p_idempotency_key, ''))) not between 8 and 255
  then
    raise exception using errcode = '22023', message = 'Parâmetros de ajuste administrativo inválidos.';
  end if;
  if not exists (
    select 1 from public.twitter_connections connection
    where connection.id = p_connection_id
      and connection.organization_id = p_organization_id
      and connection.identity_id = p_identity_id
      and connection.deleted_at is null
      and connection.status <> 'deleted'
  ) then
    raise exception using errcode = 'P0002', message = 'Conexão X ativa não encontrada para a carteira.';
  end if;

  select * into ledger_row
  from public.twitter_wallet_ledger
  where idempotency_key = trim(p_idempotency_key);
  if found then
    select * into wallet_row from public.twitter_wallets where identity_id = p_identity_id;
    return jsonb_build_object(
      'idempotentReplay', true,
      'ledgerId', ledger_row.id,
      'deltaMicros', ledger_row.delta_micros,
      'postedBalanceMicros', wallet_row.posted_balance_micros,
      'reservedMicros', wallet_row.reserved_micros,
      'availableMicros', wallet_row.posted_balance_micros - wallet_row.reserved_micros,
      'walletVersion', wallet_row.version
    );
  end if;

  select * into wallet_row
  from public.twitter_wallets
  where identity_id = p_identity_id and organization_id = p_organization_id
  for update;
  if not found then raise exception using errcode = 'P0002', message = 'Carteira X não encontrada.'; end if;
  if wallet_row.posted_balance_micros <> p_expected_posted_micros then
    raise exception using errcode = '40001', message = 'O saldo mudou; reconfirme antes de ajustar.';
  end if;
  if p_target_posted_micros < wallet_row.reserved_micros then
    raise exception using errcode = '23514', message = 'O saldo-alvo não cobre as reservas abertas.';
  end if;
  delta := p_target_posted_micros - wallet_row.posted_balance_micros;
  if delta = 0 then
    return jsonb_build_object(
      'idempotentReplay', false, 'noChange', true, 'deltaMicros', 0,
      'postedBalanceMicros', wallet_row.posted_balance_micros,
      'reservedMicros', wallet_row.reserved_micros,
      'availableMicros', wallet_row.posted_balance_micros - wallet_row.reserved_micros,
      'walletVersion', wallet_row.version
    );
  end if;

  insert into public.twitter_wallet_ledger(
    identity_id, organization_id, connection_id, origin, entry_kind,
    delta_micros, idempotency_key, actor_user_id, actor_email, metadata
  ) values (
    p_identity_id, p_organization_id, p_connection_id, 'administration',
    case when delta > 0 then 'credit'::public.twitter_ledger_entry_kind
         else 'adjustment'::public.twitter_ledger_entry_kind end,
    delta, trim(p_idempotency_key), p_actor_user_id,
    nullif(trim(coalesce(p_actor_email, '')), ''),
    jsonb_build_object(
      'reason', trim(p_reason),
      'expectedPostedMicros', p_expected_posted_micros,
      'targetPostedMicros', p_target_posted_micros,
      'operation', 'set_existing_wallet_balance'
    )
  ) returning * into ledger_row;

  update public.twitter_wallets
  set posted_balance_micros = p_target_posted_micros,
      version = version + 1
  where identity_id = p_identity_id
  returning * into wallet_row;

  return jsonb_build_object(
    'idempotentReplay', false,
    'ledgerId', ledger_row.id,
    'deltaMicros', delta,
    'postedBalanceMicros', wallet_row.posted_balance_micros,
    'reservedMicros', wallet_row.reserved_micros,
    'availableMicros', wallet_row.posted_balance_micros - wallet_row.reserved_micros,
    'walletVersion', wallet_row.version
  );
end;
$$;

revoke all on function public.twitter_set_wallet_balance_admin(
  uuid,uuid,uuid,bigint,bigint,text,text,uuid,text
) from public, anon, authenticated;
grant execute on function public.twitter_set_wallet_balance_admin(
  uuid,uuid,uuid,bigint,bigint,text,text,uuid,text
) to service_role;
