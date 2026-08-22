-- Módulo X/Twitter: fundação isolada, carteira sintética e reservas atômicas.
-- Migration aditiva; não altera tabelas, tipos, RPCs ou workers do Instagram.

create type public.twitter_connection_status as enum (
  'pending', 'active', 'needs_reauth', 'disabled', 'deleted'
);

create type public.twitter_price_category as enum (
  'post_read',
  'user_read_follow_article',
  'post_dm_create',
  'post_create_url'
);

create type public.twitter_financial_origin as enum (
  'publication', 'analytics', 'administration'
);

create type public.twitter_ledger_entry_kind as enum (
  'grant', 'credit', 'debit', 'adjustment'
);

create type public.twitter_reservation_status as enum (
  'open', 'partially_settled', 'outcome_unknown', 'settled', 'released'
);

create type public.twitter_reservation_event_type as enum (
  'created', 'settled', 'released', 'marked_unknown', 'manual_resolution'
);

create table public.twitter_global_identities (
  id uuid primary key default gen_random_uuid(),
  zernio_user_id text not null unique check (char_length(trim(zernio_user_id)) between 1 and 255),
  current_organization_id uuid not null references public.organizations (id) on delete restrict,
  first_granted_at timestamptz,
  transferred_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index twitter_global_identities_org_idx
  on public.twitter_global_identities (current_organization_id, created_at desc);

create table public.twitter_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  identity_id uuid not null references public.twitter_global_identities (id) on delete restrict,
  label text not null check (char_length(trim(label)) between 1 and 120),
  zernio_profile_id text check (zernio_profile_id is null or char_length(zernio_profile_id) between 1 and 255),
  status public.twitter_connection_status not null default 'pending',
  analytics_enabled boolean not null default false,
  inbox_enabled boolean not null default false,
  last_verified_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_by uuid not null references auth.users (id) on delete restrict,
  deleted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (analytics_enabled = false),
  check (inbox_enabled = false)
);

create unique index twitter_connections_active_identity_idx
  on public.twitter_connections (identity_id)
  where deleted_at is null and status <> 'deleted';

create index twitter_connections_org_status_idx
  on public.twitter_connections (organization_id, status, created_at desc)
  where deleted_at is null;

create table public.twitter_connection_secrets (
  connection_id uuid primary key references public.twitter_connections (id) on delete cascade,
  encrypted_api_key text not null check (char_length(encrypted_api_key) >= 32),
  api_key_fingerprint text not null check (api_key_fingerprint ~ '^[a-f0-9]{64}$'),
  rotated_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.twitter_rate_cards (
  id uuid primary key default gen_random_uuid(),
  version integer not null unique check (version > 0),
  source text not null default 'athena_fixed' check (char_length(source) between 1 and 80),
  reason text not null check (char_length(trim(reason)) between 3 and 500),
  active boolean not null default false,
  effective_at timestamptz not null default timezone('utc', now()),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now())
);

create unique index twitter_rate_cards_one_active_idx
  on public.twitter_rate_cards ((active)) where active;

create table public.twitter_cost_rates (
  rate_card_id uuid not null references public.twitter_rate_cards (id) on delete restrict,
  category public.twitter_price_category not null,
  unit_cost_micros bigint not null check (unit_cost_micros > 0),
  created_at timestamptz not null default timezone('utc', now()),
  primary key (rate_card_id, category)
);

create table public.twitter_wallets (
  identity_id uuid primary key references public.twitter_global_identities (id) on delete restrict,
  organization_id uuid not null references public.organizations (id) on delete restrict,
  posted_balance_micros bigint not null default 0 check (posted_balance_micros >= 0),
  reserved_micros bigint not null default 0 check (reserved_micros >= 0),
  version bigint not null default 0 check (version >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (reserved_micros <= posted_balance_micros)
);

create index twitter_wallets_org_idx on public.twitter_wallets (organization_id, updated_at desc);

create table public.twitter_wallet_grants (
  id uuid primary key default gen_random_uuid(),
  identity_id uuid not null unique references public.twitter_global_identities (id) on delete restrict,
  organization_id uuid not null references public.organizations (id) on delete restrict,
  amount_micros bigint not null default 12000000 check (amount_micros = 12000000),
  idempotency_key text not null unique check (char_length(idempotency_key) between 8 and 255),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now())
);

create table public.twitter_wallet_ledger (
  id uuid primary key default gen_random_uuid(),
  identity_id uuid not null references public.twitter_global_identities (id) on delete restrict,
  organization_id uuid not null references public.organizations (id) on delete restrict,
  connection_id uuid references public.twitter_connections (id) on delete restrict,
  rate_card_id uuid references public.twitter_rate_cards (id) on delete restrict,
  category public.twitter_price_category,
  origin public.twitter_financial_origin not null,
  entry_kind public.twitter_ledger_entry_kind not null,
  delta_micros bigint not null check (delta_micros <> 0),
  source_id uuid,
  idempotency_key text not null unique check (char_length(idempotency_key) between 8 and 255),
  actor_user_id uuid references auth.users (id) on delete set null,
  actor_email text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  check (
    (entry_kind in ('grant', 'credit') and delta_micros > 0)
    or (entry_kind = 'debit' and delta_micros < 0)
    or (entry_kind = 'adjustment')
  )
);

create index twitter_wallet_ledger_org_created_idx
  on public.twitter_wallet_ledger (organization_id, created_at desc);
create index twitter_wallet_ledger_identity_created_idx
  on public.twitter_wallet_ledger (identity_id, created_at desc);

create table public.twitter_wallet_reservations (
  id uuid primary key default gen_random_uuid(),
  identity_id uuid not null references public.twitter_global_identities (id) on delete restrict,
  organization_id uuid not null references public.organizations (id) on delete restrict,
  connection_id uuid references public.twitter_connections (id) on delete restrict,
  rate_card_id uuid not null references public.twitter_rate_cards (id) on delete restrict,
  category public.twitter_price_category not null,
  origin public.twitter_financial_origin not null,
  source_id uuid not null,
  initial_micros bigint not null check (initial_micros > 0),
  remaining_micros bigint not null check (remaining_micros >= 0),
  settled_micros bigint not null default 0 check (settled_micros >= 0),
  released_micros bigint not null default 0 check (released_micros >= 0),
  status public.twitter_reservation_status not null default 'open',
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 255),
  outcome_unknown_at timestamptz,
  resolved_at timestamptz,
  resolution_reason text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (identity_id, idempotency_key),
  check (remaining_micros + settled_micros + released_micros = initial_micros),
  check ((status = 'outcome_unknown') = (outcome_unknown_at is not null))
);

create index twitter_wallet_reservations_org_status_idx
  on public.twitter_wallet_reservations (organization_id, status, created_at desc);
create index twitter_wallet_reservations_identity_open_idx
  on public.twitter_wallet_reservations (identity_id, created_at)
  where remaining_micros > 0;

create table public.twitter_reservation_events (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.twitter_wallet_reservations (id) on delete restrict,
  organization_id uuid not null references public.organizations (id) on delete restrict,
  event_type public.twitter_reservation_event_type not null,
  amount_micros bigint not null default 0 check (amount_micros >= 0),
  idempotency_key text not null unique check (char_length(idempotency_key) between 8 and 255),
  actor_user_id uuid references auth.users (id) on delete set null,
  actor_email text,
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index twitter_reservation_events_reservation_idx
  on public.twitter_reservation_events (reservation_id, created_at);

create table public.twitter_identity_transfer_events (
  id uuid primary key default gen_random_uuid(),
  identity_id uuid not null references public.twitter_global_identities (id) on delete restrict,
  from_organization_id uuid not null references public.organizations (id) on delete restrict,
  to_organization_id uuid not null references public.organizations (id) on delete restrict,
  reason text not null check (char_length(trim(reason)) between 5 and 1000),
  actor_email text not null check (char_length(trim(actor_email)) between 3 and 320),
  created_at timestamptz not null default timezone('utc', now()),
  check (from_organization_id <> to_organization_id)
);

create trigger twitter_global_identities_set_updated_at
before update on public.twitter_global_identities
for each row execute function public.set_updated_at();

create trigger twitter_connections_set_updated_at
before update on public.twitter_connections
for each row execute function public.set_updated_at();

create trigger twitter_connection_secrets_set_updated_at
before update on public.twitter_connection_secrets
for each row execute function public.set_updated_at();

create trigger twitter_wallets_set_updated_at
before update on public.twitter_wallets
for each row execute function public.set_updated_at();

create trigger twitter_wallet_reservations_set_updated_at
before update on public.twitter_wallet_reservations
for each row execute function public.set_updated_at();

create or replace function public.prevent_twitter_immutable_mutation()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  raise exception using errcode = '55000', message = 'Registro financeiro imutável.';
end;
$$;

create trigger twitter_wallet_grants_immutable
before update or delete on public.twitter_wallet_grants
for each row execute function public.prevent_twitter_immutable_mutation();

create trigger twitter_wallet_ledger_immutable
before update or delete on public.twitter_wallet_ledger
for each row execute function public.prevent_twitter_immutable_mutation();

create trigger twitter_reservation_events_immutable
before update or delete on public.twitter_reservation_events
for each row execute function public.prevent_twitter_immutable_mutation();

create trigger twitter_identity_transfer_events_immutable
before update or delete on public.twitter_identity_transfer_events
for each row execute function public.prevent_twitter_immutable_mutation();

create trigger twitter_cost_rates_immutable
before update or delete on public.twitter_cost_rates
for each row execute function public.prevent_twitter_immutable_mutation();

with inserted_card as (
  insert into public.twitter_rate_cards (version, source, reason, active)
  values (1, 'athena_fixed', 'Tabela inicial aprovada para operações X via Zernio.', true)
  returning id
)
insert into public.twitter_cost_rates (rate_card_id, category, unit_cost_micros)
select id, category, unit_cost_micros
from inserted_card
cross join (values
  ('post_read'::public.twitter_price_category, 5000::bigint),
  ('user_read_follow_article'::public.twitter_price_category, 10000::bigint),
  ('post_dm_create'::public.twitter_price_category, 15000::bigint),
  ('post_create_url'::public.twitter_price_category, 200000::bigint)
) as rate(category, unit_cost_micros);

create or replace function public.twitter_register_identity_and_grant(
  p_organization_id uuid,
  p_zernio_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_user_id text := trim(coalesce(p_zernio_user_id, ''));
  identity_row public.twitter_global_identities;
  wallet_row public.twitter_wallets;
  created_grant boolean := false;
  current_actor uuid := auth.uid();
begin
  if coalesce(auth.role(), '') <> 'service_role'
    and not public.has_organization_role(p_organization_id, array['admin']::public.organization_role[])
  then
    raise exception using errcode = '42501', message = 'Apenas administradores podem cadastrar uma identidade Zernio do X.';
  end if;
  if char_length(normalized_user_id) not between 1 and 255 then
    raise exception using errcode = '22023', message = 'Identidade Zernio inválida.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('twitter-identity:' || normalized_user_id, 0));
  select * into identity_row
  from public.twitter_global_identities
  where zernio_user_id = normalized_user_id
  for update;

  if found and identity_row.current_organization_id <> p_organization_id then
    raise exception using errcode = '23505', message = 'Esta identidade Zernio não está disponível para cadastro.';
  end if;

  if not found then
    insert into public.twitter_global_identities (zernio_user_id, current_organization_id)
    values (normalized_user_id, p_organization_id)
    returning * into identity_row;
  end if;

  insert into public.twitter_wallets (identity_id, organization_id)
  values (identity_row.id, p_organization_id)
  on conflict (identity_id) do nothing;

  insert into public.twitter_wallet_grants (
    identity_id, organization_id, amount_micros, idempotency_key, created_by
  ) values (
    identity_row.id, p_organization_id, 12000000,
    'twitter-initial-grant:' || identity_row.id::text,
    current_actor
  )
  on conflict (identity_id) do nothing
  returning true into created_grant;

  if coalesce(created_grant, false) then
    insert into public.twitter_wallet_ledger (
      identity_id, organization_id, origin, entry_kind, delta_micros,
      idempotency_key, actor_user_id, actor_email, metadata
    ) values (
      identity_row.id, p_organization_id, 'administration', 'grant', 12000000,
      'twitter-initial-ledger:' || identity_row.id::text,
      current_actor, nullif(auth.jwt() ->> 'email', ''),
      jsonb_build_object('grant', 'initial')
    );

    update public.twitter_wallets
    set posted_balance_micros = posted_balance_micros + 12000000,
        version = version + 1
    where identity_id = identity_row.id
    returning * into wallet_row;

    update public.twitter_global_identities
    set first_granted_at = coalesce(first_granted_at, timezone('utc', now()))
    where id = identity_row.id;
  else
    select * into wallet_row from public.twitter_wallets where identity_id = identity_row.id;
  end if;

  return jsonb_build_object(
    'identityId', identity_row.id,
    'grantCreated', coalesce(created_grant, false),
    'postedBalanceMicros', wallet_row.posted_balance_micros,
    'reservedMicros', wallet_row.reserved_micros,
    'availableMicros', wallet_row.posted_balance_micros - wallet_row.reserved_micros,
    'walletVersion', wallet_row.version
  );
end;
$$;

create or replace function public.twitter_get_wallet_snapshot(
  p_organization_id uuid,
  p_identity_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  wallet_row public.twitter_wallets;
  active_rate_card record;
begin
  if coalesce(auth.role(), '') <> 'service_role'
    and not public.is_organization_member(p_organization_id)
  then
    raise exception using errcode = '42501', message = 'Organização não autorizada.';
  end if;

  select * into wallet_row
  from public.twitter_wallets
  where identity_id = p_identity_id and organization_id = p_organization_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Carteira não encontrada.';
  end if;

  select id, version into active_rate_card
  from public.twitter_rate_cards where active order by version desc limit 1;

  return jsonb_build_object(
    'identityId', wallet_row.identity_id,
    'postedBalanceMicros', wallet_row.posted_balance_micros,
    'reservedMicros', wallet_row.reserved_micros,
    'availableMicros', wallet_row.posted_balance_micros - wallet_row.reserved_micros,
    'walletVersion', wallet_row.version,
    'rateCardId', active_rate_card.id,
    'rateCardVersion', active_rate_card.version
  );
end;
$$;

create or replace function public.twitter_create_wallet_reservation(
  p_organization_id uuid,
  p_identity_id uuid,
  p_connection_id uuid,
  p_rate_card_version integer,
  p_category public.twitter_price_category,
  p_origin public.twitter_financial_origin,
  p_source_id uuid,
  p_amount_micros bigint,
  p_expected_wallet_version bigint,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  wallet_row public.twitter_wallets;
  rate_row record;
  reservation_row public.twitter_wallet_reservations;
begin
  if coalesce(auth.role(), '') <> 'service_role'
    and not public.has_organization_role(p_organization_id, array['admin', 'operator']::public.organization_role[])
  then
    raise exception using errcode = '42501', message = 'Sem permissão para reservar saldo.';
  end if;
  if p_amount_micros <= 0 or char_length(trim(coalesce(p_idempotency_key, ''))) not between 8 and 255 then
    raise exception using errcode = '22023', message = 'Reserva inválida.';
  end if;

  select reservation.* into reservation_row
  from public.twitter_wallet_reservations reservation
  where reservation.identity_id = p_identity_id
    and reservation.idempotency_key = trim(p_idempotency_key);
  if found then
    return jsonb_build_object(
      'reservationId', reservation_row.id,
      'idempotentReplay', true,
      'reservedMicros', reservation_row.initial_micros,
      'status', reservation_row.status
    );
  end if;

  select * into wallet_row
  from public.twitter_wallets
  where identity_id = p_identity_id and organization_id = p_organization_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Carteira não encontrada.';
  end if;
  if wallet_row.version <> p_expected_wallet_version then
    raise exception using errcode = '40001', message = 'A carteira mudou; revise novamente.';
  end if;

  select card.id, rate.unit_cost_micros into rate_row
  from public.twitter_rate_cards card
  join public.twitter_cost_rates rate on rate.rate_card_id = card.id
  where card.version = p_rate_card_version and rate.category = p_category;
  if not found then
    raise exception using errcode = '22023', message = 'Rate card inválido.';
  end if;
  if mod(p_amount_micros, rate_row.unit_cost_micros) <> 0 then
    raise exception using errcode = '22023', message = 'O valor da reserva não corresponde à unidade do rate card.';
  end if;
  if p_connection_id is not null and not exists (
    select 1 from public.twitter_connections connection
    where connection.id = p_connection_id
      and connection.identity_id = p_identity_id
      and connection.organization_id = p_organization_id
      and connection.deleted_at is null
  ) then
    raise exception using errcode = '22023', message = 'Conexão incompatível com a carteira.';
  end if;
  if wallet_row.posted_balance_micros - wallet_row.reserved_micros < p_amount_micros then
    raise exception using errcode = 'P0001', message = 'Saldo insuficiente.';
  end if;

  insert into public.twitter_wallet_reservations (
    identity_id, organization_id, connection_id, rate_card_id, category, origin,
    source_id, initial_micros, remaining_micros, idempotency_key, created_by
  ) values (
    p_identity_id, p_organization_id, p_connection_id, rate_row.id, p_category, p_origin,
    p_source_id, p_amount_micros, p_amount_micros, trim(p_idempotency_key), auth.uid()
  ) returning * into reservation_row;

  update public.twitter_wallets
  set reserved_micros = reserved_micros + p_amount_micros,
      version = version + 1
  where identity_id = p_identity_id
  returning * into wallet_row;

  insert into public.twitter_reservation_events (
    reservation_id, organization_id, event_type, amount_micros, idempotency_key,
    actor_user_id, actor_email, metadata
  ) values (
    reservation_row.id, p_organization_id, 'created', p_amount_micros,
    'created:' || reservation_row.id::text,
    auth.uid(), nullif(auth.jwt() ->> 'email', ''),
    jsonb_build_object('sourceId', p_source_id)
  );

  return jsonb_build_object(
    'reservationId', reservation_row.id,
    'idempotentReplay', false,
    'reservedMicros', reservation_row.initial_micros,
    'walletVersion', wallet_row.version,
    'availableMicros', wallet_row.posted_balance_micros - wallet_row.reserved_micros,
    'status', reservation_row.status
  );
end;
$$;

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
      case when p_manual_resolution then 'manual_resolution' else 'released' end,
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
    case when p_manual_resolution then 'manual_resolution' else 'released' end,
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
      status = case when remaining_micros - p_amount_micros = 0 then 'settled' else 'partially_settled' end,
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

create or replace function public.twitter_mark_reservation_outcome_unknown(
  p_reservation_id uuid,
  p_idempotency_key text,
  p_reason text,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare reservation_row public.twitter_wallet_reservations;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Apenas service_role pode marcar resultado externo desconhecido.';
  end if;
  if char_length(trim(coalesce(p_reason, ''))) < 3
    or char_length(trim(coalesce(p_idempotency_key, ''))) not between 8 and 255
  then
    raise exception using errcode = '22023', message = 'Motivo e idempotency key são obrigatórios.';
  end if;

  select * into reservation_row from public.twitter_wallet_reservations
  where id = p_reservation_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Reserva não encontrada.'; end if;
  if exists (select 1 from public.twitter_reservation_events where idempotency_key = trim(p_idempotency_key)) then
    return jsonb_build_object('reservationId', reservation_row.id, 'idempotentReplay', true, 'status', reservation_row.status);
  end if;
  if reservation_row.remaining_micros = 0 then
    raise exception using errcode = '55000', message = 'Reserva encerrada não pode ficar desconhecida.';
  end if;

  update public.twitter_wallet_reservations
  set status = 'outcome_unknown',
      outcome_unknown_at = timezone('utc', now()),
      resolution_reason = trim(p_reason)
  where id = reservation_row.id
  returning * into reservation_row;

  insert into public.twitter_reservation_events (
    reservation_id, organization_id, event_type, amount_micros, idempotency_key,
    reason, metadata
  ) values (
    reservation_row.id, reservation_row.organization_id, 'marked_unknown', 0,
    trim(p_idempotency_key), trim(p_reason), coalesce(p_metadata, '{}'::jsonb)
  );

  return jsonb_build_object('reservationId', reservation_row.id, 'idempotentReplay', false, 'status', reservation_row.status);
end;
$$;

create or replace function public.twitter_transfer_identity_organization(
  p_identity_id uuid,
  p_from_organization_id uuid,
  p_to_organization_id uuid,
  p_reason text,
  p_actor_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare identity_row public.twitter_global_identities;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Transferência exige operação de suporte com service_role.';
  end if;
  if p_from_organization_id = p_to_organization_id
    or char_length(trim(coalesce(p_reason, ''))) < 5
    or char_length(trim(coalesce(p_actor_email, ''))) < 3
  then
    raise exception using errcode = '22023', message = 'Transferência inválida.';
  end if;

  select * into identity_row from public.twitter_global_identities
  where id = p_identity_id for update;
  if not found or identity_row.current_organization_id <> p_from_organization_id then
    raise exception using errcode = 'P0002', message = 'Identidade não encontrada para transferência.';
  end if;
  if exists (
    select 1 from public.twitter_wallet_reservations
    where identity_id = p_identity_id and remaining_micros > 0
  ) then
    raise exception using errcode = '55000', message = 'Resolva todas as reservas antes da transferência.';
  end if;
  if exists (
    select 1 from public.twitter_connections
    where identity_id = p_identity_id and deleted_at is null and status <> 'deleted'
  ) then
    raise exception using errcode = '55000', message = 'Remova a conexão ativa antes da transferência.';
  end if;

  update public.twitter_global_identities
  set current_organization_id = p_to_organization_id,
      transferred_at = timezone('utc', now())
  where id = p_identity_id;
  update public.twitter_wallets
  set organization_id = p_to_organization_id,
      version = version + 1
  where identity_id = p_identity_id;

  insert into public.twitter_identity_transfer_events (
    identity_id, from_organization_id, to_organization_id, reason, actor_email
  ) values (
    p_identity_id, p_from_organization_id, p_to_organization_id,
    trim(p_reason), lower(trim(p_actor_email))
  );

  return jsonb_build_object('identityId', p_identity_id, 'transferred', true);
end;
$$;

alter table public.twitter_global_identities enable row level security;
alter table public.twitter_connections enable row level security;
alter table public.twitter_connection_secrets enable row level security;
alter table public.twitter_rate_cards enable row level security;
alter table public.twitter_cost_rates enable row level security;
alter table public.twitter_wallets enable row level security;
alter table public.twitter_wallet_grants enable row level security;
alter table public.twitter_wallet_ledger enable row level security;
alter table public.twitter_wallet_reservations enable row level security;
alter table public.twitter_reservation_events enable row level security;
alter table public.twitter_identity_transfer_events enable row level security;

create policy twitter_global_identities_select_member
on public.twitter_global_identities for select to authenticated
using (public.is_organization_member(current_organization_id));

create policy twitter_connections_select_member
on public.twitter_connections for select to authenticated
using (public.is_organization_member(organization_id));

create policy twitter_connections_insert_admin
on public.twitter_connections for insert to authenticated
with check (
  created_by = (select auth.uid())
  and public.has_organization_role(organization_id, array['admin']::public.organization_role[])
  and exists (
    select 1 from public.twitter_global_identities identity
    where identity.id = identity_id and identity.current_organization_id = organization_id
  )
);

create policy twitter_connections_update_admin
on public.twitter_connections for update to authenticated
using (public.has_organization_role(organization_id, array['admin']::public.organization_role[]))
with check (
  public.has_organization_role(organization_id, array['admin']::public.organization_role[])
  and analytics_enabled = false and inbox_enabled = false
);

create policy twitter_rate_cards_select_authenticated
on public.twitter_rate_cards for select to authenticated using (true);
create policy twitter_cost_rates_select_authenticated
on public.twitter_cost_rates for select to authenticated using (true);

create policy twitter_wallets_select_member
on public.twitter_wallets for select to authenticated
using (public.is_organization_member(organization_id));
create policy twitter_wallet_grants_select_member
on public.twitter_wallet_grants for select to authenticated
using (public.is_organization_member(organization_id));
create policy twitter_wallet_ledger_select_member
on public.twitter_wallet_ledger for select to authenticated
using (public.is_organization_member(organization_id));
create policy twitter_wallet_reservations_select_member
on public.twitter_wallet_reservations for select to authenticated
using (public.is_organization_member(organization_id));
create policy twitter_reservation_events_select_member
on public.twitter_reservation_events for select to authenticated
using (public.is_organization_member(organization_id));

revoke all on table
  public.twitter_global_identities,
  public.twitter_connections,
  public.twitter_connection_secrets,
  public.twitter_rate_cards,
  public.twitter_cost_rates,
  public.twitter_wallets,
  public.twitter_wallet_grants,
  public.twitter_wallet_ledger,
  public.twitter_wallet_reservations,
  public.twitter_reservation_events,
  public.twitter_identity_transfer_events
from anon;

grant select on table
  public.twitter_global_identities,
  public.twitter_connections,
  public.twitter_rate_cards,
  public.twitter_cost_rates,
  public.twitter_wallets,
  public.twitter_wallet_grants,
  public.twitter_wallet_ledger,
  public.twitter_wallet_reservations,
  public.twitter_reservation_events
to authenticated;

grant insert, update on table public.twitter_connections to authenticated;
grant select, insert, update, delete on table
  public.twitter_global_identities,
  public.twitter_connections,
  public.twitter_connection_secrets,
  public.twitter_rate_cards,
  public.twitter_cost_rates,
  public.twitter_wallets,
  public.twitter_wallet_grants,
  public.twitter_wallet_ledger,
  public.twitter_wallet_reservations,
  public.twitter_reservation_events,
  public.twitter_identity_transfer_events
to service_role;

revoke all on function public.prevent_twitter_immutable_mutation() from public;
revoke all on function public.twitter_register_identity_and_grant(uuid, text) from public;
grant execute on function public.twitter_register_identity_and_grant(uuid, text) to authenticated, service_role;
revoke all on function public.twitter_get_wallet_snapshot(uuid, uuid) from public;
grant execute on function public.twitter_get_wallet_snapshot(uuid, uuid) to authenticated, service_role;
revoke all on function public.twitter_create_wallet_reservation(uuid, uuid, uuid, integer, public.twitter_price_category, public.twitter_financial_origin, uuid, bigint, bigint, text) from public;
grant execute on function public.twitter_create_wallet_reservation(uuid, uuid, uuid, integer, public.twitter_price_category, public.twitter_financial_origin, uuid, bigint, bigint, text) to authenticated, service_role;
revoke all on function public.twitter_release_wallet_reservation(uuid, text, text, boolean) from public;
grant execute on function public.twitter_release_wallet_reservation(uuid, text, text, boolean) to authenticated, service_role;
revoke all on function public.twitter_settle_wallet_reservation(uuid, bigint, text, jsonb) from public;
grant execute on function public.twitter_settle_wallet_reservation(uuid, bigint, text, jsonb) to service_role;
revoke all on function public.twitter_mark_reservation_outcome_unknown(uuid, text, text, jsonb) from public;
grant execute on function public.twitter_mark_reservation_outcome_unknown(uuid, text, text, jsonb) to service_role;
revoke all on function public.twitter_transfer_identity_organization(uuid, uuid, uuid, text, text) from public;
grant execute on function public.twitter_transfer_identity_organization(uuid, uuid, uuid, text, text) to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'twitter-media',
  'twitter-media',
  false,
  536870912,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/quicktime']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy twitter_media_objects_select_member
on storage.objects for select to authenticated
using (
  bucket_id = 'twitter-media'
  and public.is_organization_member((storage.foldername(name))[1]::uuid)
);

create policy twitter_media_objects_insert_operator
on storage.objects for insert to authenticated
with check (
  bucket_id = 'twitter-media'
  and public.has_organization_role(
    (storage.foldername(name))[1]::uuid,
    array['admin', 'operator']::public.organization_role[]
  )
  and owner_id = (select auth.uid())::text
);

create policy twitter_media_objects_update_operator
on storage.objects for update to authenticated
using (
  bucket_id = 'twitter-media'
  and public.has_organization_role(
    (storage.foldername(name))[1]::uuid,
    array['admin', 'operator']::public.organization_role[]
  )
)
with check (
  bucket_id = 'twitter-media'
  and public.has_organization_role(
    (storage.foldername(name))[1]::uuid,
    array['admin', 'operator']::public.organization_role[]
  )
);

create policy twitter_media_objects_delete_operator
on storage.objects for delete to authenticated
using (
  bucket_id = 'twitter-media'
  and public.has_organization_role(
    (storage.foldername(name))[1]::uuid,
    array['admin', 'operator']::public.organization_role[]
  )
);
