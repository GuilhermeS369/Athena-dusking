-- Reconciliação financeira retroativa para uso X confirmado na fatura do provedor.
-- Isolada em twitter_*; não altera filas, workers ou tabelas do Instagram.

create table public.twitter_provider_usage_reconciliations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  identity_id uuid not null references public.twitter_global_identities(id) on delete restrict,
  connection_id uuid not null references public.twitter_connections(id) on delete restrict,
  rate_card_id uuid not null references public.twitter_rate_cards(id) on delete restrict,
  usage_date date not null,
  category public.twitter_price_category not null,
  operation_count integer not null check (operation_count > 0),
  observed_operation_total integer not null check (observed_operation_total >= operation_count),
  unit_cost_micros bigint not null check (unit_cost_micros > 0),
  amount_micros bigint not null check (amount_micros = operation_count::bigint * unit_cost_micros),
  justification text not null check (char_length(trim(justification)) between 10 and 1000),
  evidence jsonb not null default '{}'::jsonb,
  idempotency_key text not null unique check (char_length(trim(idempotency_key)) between 8 and 200),
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_email text,
  created_at timestamptz not null default timezone('utc', now()),
  unique (identity_id, usage_date, category, observed_operation_total)
);

create trigger twitter_provider_usage_reconciliations_immutable
before update or delete on public.twitter_provider_usage_reconciliations
for each row execute function public.prevent_twitter_immutable_mutation();

create index twitter_provider_usage_reconciliations_org_created_idx
on public.twitter_provider_usage_reconciliations(organization_id, created_at desc);

create or replace function public.twitter_reconcile_provider_usage(
  p_organization_id uuid,
  p_identity_id uuid,
  p_connection_id uuid,
  p_usage_date date,
  p_category public.twitter_price_category,
  p_operation_count integer,
  p_observed_operation_total integer,
  p_rate_card_version integer,
  p_expected_wallet_version bigint,
  p_justification text,
  p_evidence jsonb,
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
  existing_row public.twitter_provider_usage_reconciliations;
  wallet_row public.twitter_wallets;
  rate_row record;
  reconciliation_row public.twitter_provider_usage_reconciliations;
  amount bigint;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Apenas service_role pode reconciliar uso retroativo do provedor.';
  end if;
  if p_usage_date is null or p_operation_count <= 0
    or p_observed_operation_total < p_operation_count
    or char_length(trim(coalesce(p_justification, ''))) not between 10 and 1000
    or char_length(trim(coalesce(p_idempotency_key, ''))) not between 8 and 200
  then
    raise exception using errcode = '22023', message = 'Reconciliação de uso inválida.';
  end if;

  select * into existing_row
  from public.twitter_provider_usage_reconciliations
  where idempotency_key = trim(p_idempotency_key);
  if found then
    return jsonb_build_object(
      'reconciliationId', existing_row.id,
      'amountMicros', existing_row.amount_micros,
      'idempotentReplay', true
    );
  end if;

  if not exists (
    select 1 from public.twitter_connections connection
    where connection.id = p_connection_id
      and connection.organization_id = p_organization_id
      and connection.identity_id = p_identity_id
      and connection.deleted_at is null
  ) then
    raise exception using errcode = '22023', message = 'Conexão incompatível com a carteira.';
  end if;

  select card.id, rate.unit_cost_micros into rate_row
  from public.twitter_rate_cards card
  join public.twitter_cost_rates rate on rate.rate_card_id = card.id
  where card.version = p_rate_card_version and rate.category = p_category;
  if not found then
    raise exception using errcode = '22023', message = 'Rate card inválido.';
  end if;
  amount := p_operation_count::bigint * rate_row.unit_cost_micros;

  select * into wallet_row from public.twitter_wallets
  where identity_id = p_identity_id and organization_id = p_organization_id
  for update;
  if not found then raise exception using errcode = 'P0002', message = 'Carteira não encontrada.'; end if;
  if wallet_row.version <> p_expected_wallet_version then
    raise exception using errcode = '40001', message = 'A carteira mudou; reconfira o billing.';
  end if;
  if wallet_row.posted_balance_micros < amount then
    raise exception using errcode = 'P0001', message = 'Saldo insuficiente para reconciliar o uso confirmado.';
  end if;

  insert into public.twitter_provider_usage_reconciliations(
    organization_id, identity_id, connection_id, rate_card_id, usage_date, category,
    operation_count, observed_operation_total, unit_cost_micros, amount_micros,
    justification, evidence, idempotency_key, actor_user_id, actor_email
  ) values (
    p_organization_id, p_identity_id, p_connection_id, rate_row.id, p_usage_date, p_category,
    p_operation_count, p_observed_operation_total, rate_row.unit_cost_micros, amount,
    trim(p_justification), coalesce(p_evidence, '{}'::jsonb), trim(p_idempotency_key),
    p_actor_user_id, nullif(trim(coalesce(p_actor_email, '')), '')
  ) returning * into reconciliation_row;

  insert into public.twitter_wallet_ledger(
    identity_id, organization_id, connection_id, rate_card_id, category, origin,
    entry_kind, delta_micros, source_id, idempotency_key, actor_user_id, actor_email, metadata
  ) values (
    p_identity_id, p_organization_id, p_connection_id, rate_row.id, p_category, 'administration',
    'debit', -amount, reconciliation_row.id, 'provider-usage-debit:' || trim(p_idempotency_key),
    p_actor_user_id, nullif(trim(coalesce(p_actor_email, '')), ''),
    jsonb_build_object('providerUsageReconciliationId', reconciliation_row.id)
      || coalesce(p_evidence, '{}'::jsonb)
  );

  update public.twitter_wallets
  set posted_balance_micros = posted_balance_micros - amount,
      version = version + 1
  where identity_id = p_identity_id
  returning * into wallet_row;

  return jsonb_build_object(
    'reconciliationId', reconciliation_row.id,
    'amountMicros', amount,
    'postedBalanceMicros', wallet_row.posted_balance_micros,
    'reservedMicros', wallet_row.reserved_micros,
    'walletVersion', wallet_row.version,
    'idempotentReplay', false
  );
end;
$$;

alter table public.twitter_provider_usage_reconciliations enable row level security;

create policy twitter_provider_usage_reconciliations_select_member
on public.twitter_provider_usage_reconciliations for select to authenticated
using (public.is_organization_member(organization_id));

revoke all on table public.twitter_provider_usage_reconciliations from public, anon, authenticated;
grant select on table public.twitter_provider_usage_reconciliations to authenticated;
grant all on table public.twitter_provider_usage_reconciliations to service_role;
revoke all on function public.twitter_reconcile_provider_usage(uuid,uuid,uuid,date,public.twitter_price_category,integer,integer,integer,bigint,text,jsonb,text,uuid,text) from public, anon, authenticated;
grant execute on function public.twitter_reconcile_provider_usage(uuid,uuid,uuid,date,public.twitter_price_category,integer,integer,integer,bigint,text,jsonb,text,uuid,text) to service_role;

