-- Paridade da administração Zernio X: importação em massa, saldo inicial
-- configurável por lote e capacidade transacional por conexão.

alter table public.twitter_wallet_grants
  drop constraint if exists twitter_wallet_grants_amount_micros_check;
alter table public.twitter_wallet_grants
  add constraint twitter_wallet_grants_amount_micros_check
  check (amount_micros between 15000 and 1000000000000);

alter table public.twitter_connections
  add column if not exists twitter_slot_limit integer not null default 2,
  add column if not exists remote_twitter_account_count integer,
  add column if not exists remote_inventory_checked_at timestamptz;

alter table public.twitter_connections
  drop constraint if exists twitter_connections_twitter_slot_limit_check;
alter table public.twitter_connections
  add constraint twitter_connections_twitter_slot_limit_check
  check (twitter_slot_limit between 1 and 100);

alter table public.twitter_connections
  drop constraint if exists twitter_connections_remote_twitter_account_count_check;
alter table public.twitter_connections
  add constraint twitter_connections_remote_twitter_account_count_check
  check (remote_twitter_account_count is null or remote_twitter_account_count between 0 and 500);

create unique index if not exists twitter_connections_active_org_label_idx
  on public.twitter_connections (organization_id, lower(trim(label)))
  where deleted_at is null and status <> 'deleted';

create unique index if not exists twitter_connection_secrets_fingerprint_unique_idx
  on public.twitter_connection_secrets (api_key_fingerprint);

create table public.twitter_organization_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  default_initial_grant_micros bigint not null default 12000000
    check (default_initial_grant_micros between 15000 and 1000000000000),
  default_twitter_slot_limit integer not null default 2
    check (default_twitter_slot_limit between 1 and 100),
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);
create trigger twitter_organization_settings_set_updated_at
before update on public.twitter_organization_settings
for each row execute function public.set_updated_at();

create table public.twitter_api_key_registry (
  api_key_fingerprint text primary key check (api_key_fingerprint ~ '^[a-f0-9]{64}$'),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  connection_id uuid references public.twitter_connections(id) on delete restrict,
  import_item_id uuid,
  status text not null check (status in ('reserved', 'active', 'retired')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);
create trigger twitter_api_key_registry_set_updated_at
before update on public.twitter_api_key_registry
for each row execute function public.set_updated_at();

insert into public.twitter_api_key_registry (
  api_key_fingerprint, organization_id, connection_id, status
)
select secret.api_key_fingerprint, connection.organization_id, connection.id, 'active'
from public.twitter_connection_secrets secret
join public.twitter_connections connection on connection.id = secret.connection_id
where connection.deleted_at is null and connection.status <> 'deleted'
on conflict (api_key_fingerprint) do nothing;

create table public.twitter_connection_import_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'completed', 'completed_with_errors')),
  total_count integer not null check (total_count between 1 and 100),
  created_by uuid not null references auth.users(id) on delete restrict,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);
create index twitter_connection_import_batches_org_created_idx
  on public.twitter_connection_import_batches(organization_id, created_at desc);
create trigger twitter_connection_import_batches_set_updated_at
before update on public.twitter_connection_import_batches
for each row execute function public.set_updated_at();

create table public.twitter_connection_import_items (
  id uuid primary key,
  batch_id uuid not null references public.twitter_connection_import_batches(id) on delete restrict,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  line_number integer not null check (line_number between 1 and 100),
  label text not null check (char_length(trim(label)) between 2 and 120),
  encrypted_api_key text not null check (char_length(encrypted_api_key) >= 32),
  api_key_fingerprint text not null check (api_key_fingerprint ~ '^[a-f0-9]{64}$'),
  initial_grant_micros_snapshot bigint not null
    check (initial_grant_micros_snapshot between 15000 and 1000000000000),
  twitter_slot_limit_snapshot integer not null
    check (twitter_slot_limit_snapshot between 1 and 100),
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'succeeded', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  twitter_connection_id uuid references public.twitter_connections(id) on delete restrict,
  processing_started_at timestamptz,
  completed_at timestamptz,
  last_error_message text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique(batch_id, line_number)
);
create index twitter_connection_import_items_batch_line_idx
  on public.twitter_connection_import_items(batch_id, line_number);
create trigger twitter_connection_import_items_set_updated_at
before update on public.twitter_connection_import_items
for each row execute function public.set_updated_at();

alter table public.twitter_api_key_registry
  add constraint twitter_api_key_registry_import_item_fk
  foreign key (import_item_id) references public.twitter_connection_import_items(id) on delete restrict;

create or replace function public.twitter_register_identity_and_grant(
  p_organization_id uuid,
  p_zernio_user_id text,
  p_initial_grant_micros bigint
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
  grant_row public.twitter_wallet_grants;
  created_grant boolean := false;
  current_actor uuid := auth.uid();
begin
  if coalesce(auth.role(), '') <> 'service_role'
    and not public.has_organization_role(p_organization_id, array['admin']::public.organization_role[])
  then
    raise exception using errcode = '42501', message = 'Apenas administradores podem cadastrar uma identidade Zernio do X.';
  end if;
  if char_length(normalized_user_id) not between 1 and 255
    or p_initial_grant_micros not between 15000 and 1000000000000
  then
    raise exception using errcode = '22023', message = 'Identidade ou saldo inicial Zernio inválido.';
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
    insert into public.twitter_global_identities(zernio_user_id, current_organization_id)
    values(normalized_user_id, p_organization_id)
    returning * into identity_row;
  end if;

  insert into public.twitter_wallets(identity_id, organization_id)
  values(identity_row.id, p_organization_id)
  on conflict(identity_id) do nothing;

  insert into public.twitter_wallet_grants(
    identity_id, organization_id, amount_micros, idempotency_key, created_by
  ) values (
    identity_row.id, p_organization_id, p_initial_grant_micros,
    'twitter-initial-grant:' || identity_row.id::text, current_actor
  )
  on conflict(identity_id) do nothing
  returning * into grant_row;
  created_grant := found;

  if created_grant then
    insert into public.twitter_wallet_ledger(
      identity_id, organization_id, origin, entry_kind, delta_micros,
      idempotency_key, actor_user_id, actor_email, metadata
    ) values (
      identity_row.id, p_organization_id, 'administration', 'grant', p_initial_grant_micros,
      'twitter-initial-ledger:' || identity_row.id::text,
      current_actor, nullif(auth.jwt() ->> 'email', ''),
      jsonb_build_object('grant', 'initial', 'configuredAmountMicros', p_initial_grant_micros)
    );
    update public.twitter_wallets
    set posted_balance_micros = posted_balance_micros + p_initial_grant_micros,
        version = version + 1
    where identity_id = identity_row.id
    returning * into wallet_row;
    update public.twitter_global_identities
    set first_granted_at = coalesce(first_granted_at, timezone('utc', now()))
    where id = identity_row.id;
  else
    select * into grant_row from public.twitter_wallet_grants where identity_id = identity_row.id;
    select * into wallet_row from public.twitter_wallets where identity_id = identity_row.id;
  end if;

  return jsonb_build_object(
    'identityId', identity_row.id,
    'grantCreated', created_grant,
    'grantAmountMicros', grant_row.amount_micros,
    'postedBalanceMicros', wallet_row.posted_balance_micros,
    'reservedMicros', wallet_row.reserved_micros,
    'availableMicros', wallet_row.posted_balance_micros - wallet_row.reserved_micros,
    'walletVersion', wallet_row.version
  );
end;
$$;

create or replace function public.twitter_register_identity_and_grant(
  p_organization_id uuid,
  p_zernio_user_id text
)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.twitter_register_identity_and_grant(p_organization_id, p_zernio_user_id, 12000000::bigint);
$$;

create or replace function public.twitter_create_connection_import_batch(
  p_organization_id uuid,
  p_created_by uuid,
  p_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  batch_id uuid := gen_random_uuid();
  item jsonb;
  item_id uuid;
  fingerprint text;
  normalized_label text;
  total integer := jsonb_array_length(coalesce(p_items, '[]'::jsonb));
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Apenas service_role cria lotes Zernio X.';
  end if;
  if total not between 1 and 100 then
    raise exception using errcode = '22023', message = 'O lote Zernio X precisa ter de 1 a 100 contas.';
  end if;
  insert into public.twitter_connection_import_batches(id, organization_id, total_count, created_by)
  values(batch_id, p_organization_id, total, p_created_by);

  for item in select value from jsonb_array_elements(p_items) order by (value ->> 'lineNumber')::integer
  loop
    item_id := (item ->> 'id')::uuid;
    fingerprint := item ->> 'apiKeyFingerprint';
    normalized_label := trim(item ->> 'label');
    if char_length(normalized_label) not between 2 and 120
      or fingerprint !~ '^[a-f0-9]{64}$'
      or char_length(item ->> 'encryptedApiKey') < 32
      or (item ->> 'initialGrantMicros')::bigint not between 15000 and 1000000000000
      or (item ->> 'twitterSlotLimit')::integer not between 1 and 100
    then
      raise exception using errcode = '22023', message = 'Linha inválida no lote Zernio X.';
    end if;
    if exists(
      select 1 from public.twitter_connections connection
      where connection.organization_id = p_organization_id
        and connection.deleted_at is null and connection.status <> 'deleted'
        and lower(trim(connection.label)) = lower(normalized_label)
    ) then
      raise exception using errcode = '23505', message = 'Um nome deste lote já possui conexão Zernio X ativa.';
    end if;
    insert into public.twitter_connection_import_items(
      id, batch_id, organization_id, line_number, label, encrypted_api_key,
      api_key_fingerprint, initial_grant_micros_snapshot, twitter_slot_limit_snapshot
    ) values(
      item_id, batch_id, p_organization_id, (item ->> 'lineNumber')::integer,
      normalized_label, item ->> 'encryptedApiKey', fingerprint,
      (item ->> 'initialGrantMicros')::bigint, (item ->> 'twitterSlotLimit')::integer
    );
    update public.twitter_api_key_registry
    set organization_id = p_organization_id, connection_id = null,
        import_item_id = item_id, status = 'reserved'
    where api_key_fingerprint = fingerprint and status = 'retired';
    if not found then
      begin
        insert into public.twitter_api_key_registry(
          api_key_fingerprint, organization_id, import_item_id, status
        ) values(fingerprint, p_organization_id, item_id, 'reserved');
      exception when unique_violation then
        raise exception using errcode = '23505', message = 'Uma API key deste lote já está cadastrada ou reservada.';
      end;
    end if;
  end loop;
  return batch_id;
end;
$$;

create or replace function public.twitter_claim_connection_import_batch(p_batch_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  batch_row public.twitter_connection_import_batches;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Apenas service_role processa lotes Zernio X.';
  end if;
  select * into batch_row from public.twitter_connection_import_batches where id = p_batch_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Lote Zernio X não encontrado.'; end if;
  if batch_row.status = 'processing'
    and batch_row.started_at > timezone('utc', now()) - interval '15 minutes'
  then return false; end if;
  if exists(
    select 1 from public.twitter_connection_import_batches other
    where other.organization_id = batch_row.organization_id
      and other.id <> batch_row.id and other.status = 'processing'
      and other.started_at > timezone('utc', now()) - interval '15 minutes'
  ) then return false; end if;
  update public.twitter_connection_import_batches
  set status = 'processing', started_at = timezone('utc', now()), completed_at = null
  where id = batch_row.id;
  return true;
end;
$$;

create or replace function public.twitter_reserve_oauth_attempt(
  p_attempt_id uuid,
  p_organization_id uuid,
  p_connection_id uuid,
  p_created_by uuid,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  connection_row public.twitter_connections;
  local_count integer;
  used_count integer;
  reservation_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Apenas service_role reserva OAuth X.';
  end if;
  select * into connection_row from public.twitter_connections
  where id = p_connection_id and organization_id = p_organization_id
    and deleted_at is null and status <> 'deleted'
  for update;
  if not found then raise exception using errcode = 'P0002', message = 'Conexão Zernio X não encontrada.'; end if;
  update public.twitter_connection_oauth_attempts set status = 'expired'
  where connection_id = connection_row.id and status = 'pending' and expires_at <= timezone('utc', now());
  select count(*)::integer into local_count
  from public.twitter_profile_connection_epochs epoch
  where epoch.connection_id = connection_row.id and epoch.ended_at is null;
  used_count := greatest(coalesce(connection_row.remote_twitter_account_count, 0), local_count);
  select count(*)::integer into reservation_count
  from public.twitter_connection_oauth_attempts attempt
  where attempt.connection_id = connection_row.id and attempt.status = 'pending'
    and attempt.expires_at > timezone('utc', now());
  if used_count + reservation_count >= connection_row.twitter_slot_limit then
    raise exception using errcode = '23514', message = 'Esta conexão Zernio atingiu o limite de contas X.';
  end if;
  insert into public.twitter_connection_oauth_attempts(
    id, organization_id, connection_id, created_by, expires_at
  ) values(p_attempt_id, p_organization_id, p_connection_id, p_created_by, p_expires_at);
  return jsonb_build_object(
    'attemptId', p_attempt_id, 'usedSlots', used_count,
    'reservedSlots', reservation_count + 1, 'slotLimit', connection_row.twitter_slot_limit
  );
end;
$$;

alter table public.twitter_organization_settings enable row level security;
alter table public.twitter_api_key_registry enable row level security;
alter table public.twitter_connection_import_batches enable row level security;
alter table public.twitter_connection_import_items enable row level security;

revoke all on table public.twitter_organization_settings, public.twitter_api_key_registry,
  public.twitter_connection_import_batches, public.twitter_connection_import_items from public, anon, authenticated;
grant select, insert, update, delete on table public.twitter_organization_settings,
  public.twitter_api_key_registry, public.twitter_connection_import_batches,
  public.twitter_connection_import_items to service_role;

revoke all on function public.twitter_register_identity_and_grant(uuid,text,bigint) from public, anon, authenticated;
revoke all on function public.twitter_create_connection_import_batch(uuid,uuid,jsonb) from public, anon, authenticated;
revoke all on function public.twitter_claim_connection_import_batch(uuid) from public, anon, authenticated;
revoke all on function public.twitter_reserve_oauth_attempt(uuid,uuid,uuid,uuid,timestamptz) from public, anon, authenticated;
grant execute on function public.twitter_register_identity_and_grant(uuid,text,bigint) to service_role;
grant execute on function public.twitter_register_identity_and_grant(uuid,text) to authenticated, service_role;
grant execute on function public.twitter_create_connection_import_batch(uuid,uuid,jsonb) to service_role;
grant execute on function public.twitter_claim_connection_import_batch(uuid) to service_role;
grant execute on function public.twitter_reserve_oauth_attempt(uuid,uuid,uuid,uuid,timestamptz) to service_role;
