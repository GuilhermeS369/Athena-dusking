-- Módulo X/Twitter: conexão Zernio, perfis estáveis e épocas de conexão.

create type public.twitter_profile_status as enum (
  'active', 'offline', 'needs_reauth', 'deleted'
);

create type public.twitter_account_tier as enum (
  'unknown', 'free', 'premium'
);

create type public.twitter_identity_confidence as enum (
  'twitter_user_id', 'zernio_account_id'
);

create type public.twitter_oauth_attempt_status as enum (
  'pending', 'completed', 'failed', 'expired'
);

alter table public.twitter_connections
  add column auth_type text,
  add column auth_scope text,
  add column last_sync_at timestamptz,
  add column rotated_by uuid references auth.users (id) on delete set null,
  add column rotated_at timestamptz;

create index twitter_connection_secrets_fingerprint_idx
  on public.twitter_connection_secrets (api_key_fingerprint);

create table public.twitter_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  external_identity_key text not null unique check (char_length(external_identity_key) between 5 and 300),
  twitter_user_id text check (twitter_user_id is null or char_length(trim(twitter_user_id)) between 1 and 255),
  identity_confidence public.twitter_identity_confidence not null,
  username text not null check (char_length(trim(username)) between 1 and 120),
  display_name text check (display_name is null or char_length(trim(display_name)) between 1 and 160),
  avatar_url text check (avatar_url is null or char_length(avatar_url) <= 2000),
  status public.twitter_profile_status not null default 'offline',
  account_tier public.twitter_account_tier not null default 'unknown',
  tier_verified_at timestamptz,
  can_post boolean not null default false,
  can_fetch_analytics boolean not null default false,
  token_valid boolean not null default false,
  needs_reconnect boolean not null default false,
  current_connection_id uuid references public.twitter_connections (id) on delete restrict,
  current_epoch_id uuid,
  health_issues jsonb not null default '[]'::jsonb,
  last_health_at timestamptz,
  last_synced_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (jsonb_typeof(health_issues) = 'array')
);

create unique index twitter_profiles_twitter_user_id_idx
  on public.twitter_profiles (twitter_user_id)
  where twitter_user_id is not null;
create index twitter_profiles_org_status_idx
  on public.twitter_profiles (organization_id, status, username)
  where deleted_at is null;

create table public.twitter_profile_connection_epochs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  profile_id uuid not null references public.twitter_profiles (id) on delete restrict,
  connection_id uuid not null references public.twitter_connections (id) on delete restrict,
  zernio_account_id text not null check (char_length(trim(zernio_account_id)) between 1 and 255),
  zernio_profile_id text not null check (char_length(trim(zernio_profile_id)) between 1 and 255),
  started_at timestamptz not null default timezone('utc', now()),
  ended_at timestamptz,
  end_reason text,
  created_at timestamptz not null default timezone('utc', now()),
  check (ended_at is null or ended_at >= started_at)
);

create unique index twitter_profile_connection_epochs_current_profile_idx
  on public.twitter_profile_connection_epochs (profile_id)
  where ended_at is null;
create unique index twitter_profile_connection_epochs_current_account_idx
  on public.twitter_profile_connection_epochs (connection_id, zernio_account_id)
  where ended_at is null;
create index twitter_profile_connection_epochs_org_idx
  on public.twitter_profile_connection_epochs (organization_id, started_at desc);

alter table public.twitter_profiles
  add constraint twitter_profiles_current_epoch_fk
  foreign key (current_epoch_id)
  references public.twitter_profile_connection_epochs (id)
  on delete restrict;

create table public.twitter_connection_oauth_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  connection_id uuid not null references public.twitter_connections (id) on delete cascade,
  created_by uuid not null references auth.users (id) on delete cascade,
  status public.twitter_oauth_attempt_status not null default 'pending',
  expires_at timestamptz not null,
  completed_at timestamptz,
  error_code text,
  error_message text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (expires_at > created_at),
  check ((status = 'completed') = (completed_at is not null))
);

create index twitter_connection_oauth_attempts_pending_idx
  on public.twitter_connection_oauth_attempts (organization_id, connection_id, expires_at)
  where status = 'pending';

create table public.twitter_connection_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  connection_id uuid not null references public.twitter_connections (id) on delete restrict,
  profile_id uuid references public.twitter_profiles (id) on delete restrict,
  event_type text not null check (event_type in (
    'credential_created', 'credential_rotated', 'oauth_started', 'oauth_completed',
    'sync_completed', 'sync_failed', 'profile_connected', 'profile_reauthenticated',
    'profile_epoch_changed', 'connection_deleted'
  )),
  actor_user_id uuid references auth.users (id) on delete set null,
  actor_email text,
  error_code text,
  message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index twitter_connection_events_org_created_idx
  on public.twitter_connection_events (organization_id, created_at desc);
create index twitter_connection_events_connection_idx
  on public.twitter_connection_events (connection_id, created_at desc);

create trigger twitter_profiles_set_updated_at
before update on public.twitter_profiles
for each row execute function public.set_updated_at();
create trigger twitter_connection_oauth_attempts_set_updated_at
before update on public.twitter_connection_oauth_attempts
for each row execute function public.set_updated_at();
create trigger twitter_connection_events_immutable
before update or delete on public.twitter_connection_events
for each row execute function public.prevent_twitter_immutable_mutation();

create or replace function public.twitter_upsert_connection_credentials(
  p_organization_id uuid,
  p_identity_id uuid,
  p_label text,
  p_zernio_profile_id text,
  p_encrypted_api_key text,
  p_api_key_fingerprint text,
  p_auth_type text,
  p_auth_scope text,
  p_actor_user_id uuid,
  p_actor_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  connection_row public.twitter_connections;
  was_reused boolean := false;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Apenas service_role pode persistir credenciais Zernio.';
  end if;
  if char_length(trim(coalesce(p_label, ''))) not between 1 and 120
    or char_length(trim(coalesce(p_zernio_profile_id, ''))) not between 1 and 255
    or char_length(coalesce(p_encrypted_api_key, '')) < 32
    or coalesce(p_api_key_fingerprint, '') !~ '^[a-f0-9]{64}$'
  then
    raise exception using errcode = '22023', message = 'Dados da conexão Zernio inválidos.';
  end if;
  if not exists (
    select 1 from public.twitter_global_identities identity
    join public.twitter_wallets wallet on wallet.identity_id = identity.id
    join public.twitter_wallet_grants grant_row on grant_row.identity_id = identity.id
    where identity.id = p_identity_id
      and identity.current_organization_id = p_organization_id
      and wallet.organization_id = p_organization_id
  ) then
    raise exception using errcode = 'P0002', message = 'Identidade/carteira não registrada.';
  end if;

  select * into connection_row
  from public.twitter_connections
  where organization_id = p_organization_id and identity_id = p_identity_id
  order by created_at desc
  limit 1
  for update;

  if found then
    was_reused := true;
    update public.twitter_connections
    set label = trim(p_label),
        zernio_profile_id = trim(p_zernio_profile_id),
        status = 'active',
        analytics_enabled = false,
        inbox_enabled = false,
        auth_type = nullif(trim(coalesce(p_auth_type, '')), ''),
        auth_scope = nullif(trim(coalesce(p_auth_scope, '')), ''),
        last_verified_at = timezone('utc', now()),
        last_error_code = null,
        last_error_message = null,
        rotated_by = p_actor_user_id,
        rotated_at = timezone('utc', now()),
        deleted_at = null
    where id = connection_row.id
    returning * into connection_row;

    insert into public.twitter_connection_secrets (
      connection_id, encrypted_api_key, api_key_fingerprint, rotated_at
    ) values (
      connection_row.id, p_encrypted_api_key, p_api_key_fingerprint, timezone('utc', now())
    )
    on conflict (connection_id) do update
    set encrypted_api_key = excluded.encrypted_api_key,
        api_key_fingerprint = excluded.api_key_fingerprint,
        rotated_at = excluded.rotated_at;
  else
    insert into public.twitter_connections (
      organization_id, identity_id, label, zernio_profile_id, status,
      analytics_enabled, inbox_enabled, auth_type, auth_scope,
      last_verified_at, created_by
    ) values (
      p_organization_id, p_identity_id, trim(p_label), trim(p_zernio_profile_id), 'active',
      false, false, nullif(trim(coalesce(p_auth_type, '')), ''),
      nullif(trim(coalesce(p_auth_scope, '')), ''), timezone('utc', now()), p_actor_user_id
    ) returning * into connection_row;

    insert into public.twitter_connection_secrets (
      connection_id, encrypted_api_key, api_key_fingerprint
    ) values (
      connection_row.id, p_encrypted_api_key, p_api_key_fingerprint
    );
  end if;

  insert into public.twitter_connection_events (
    organization_id, connection_id, event_type, actor_user_id, actor_email,
    message, metadata
  ) values (
    p_organization_id, connection_row.id,
    case when was_reused then 'credential_rotated' else 'credential_created' end,
    p_actor_user_id, nullif(trim(coalesce(p_actor_email, '')), ''),
    case when was_reused then 'Credencial validada e rotacionada.' else 'Conexão Zernio X criada.' end,
    jsonb_build_object('grantReset', false, 'analyticsEnabled', false, 'inboxEnabled', false)
  );

  return jsonb_build_object(
    'connectionId', connection_row.id,
    'reused', was_reused,
    'status', connection_row.status,
    'analyticsEnabled', connection_row.analytics_enabled,
    'inboxEnabled', connection_row.inbox_enabled
  );
end;
$$;

create or replace function public.twitter_sync_profile_from_zernio(
  p_organization_id uuid,
  p_connection_id uuid,
  p_zernio_account_id text,
  p_twitter_user_id text,
  p_username text,
  p_display_name text,
  p_avatar_url text,
  p_can_post boolean,
  p_can_fetch_analytics boolean,
  p_token_valid boolean,
  p_needs_reconnect boolean,
  p_account_tier public.twitter_account_tier,
  p_health_issues jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  connection_row public.twitter_connections;
  profile_row public.twitter_profiles;
  epoch_row public.twitter_profile_connection_epochs;
  normalized_twitter_id text := nullif(trim(coalesce(p_twitter_user_id, '')), '');
  normalized_account_id text := trim(coalesce(p_zernio_account_id, ''));
  identity_key text;
  next_status public.twitter_profile_status;
  epoch_changed boolean := false;
  profile_created boolean := false;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Apenas service_role pode sincronizar perfis X.';
  end if;
  if char_length(normalized_account_id) not between 1 and 255
    or char_length(trim(coalesce(p_username, ''))) not between 1 and 120
    or jsonb_typeof(coalesce(p_health_issues, '[]'::jsonb)) <> 'array'
  then
    raise exception using errcode = '22023', message = 'Payload de perfil X inválido.';
  end if;

  select * into connection_row from public.twitter_connections
  where id = p_connection_id
    and organization_id = p_organization_id
    and status <> 'deleted'
    and deleted_at is null
  for update;
  if not found or connection_row.zernio_profile_id is null then
    raise exception using errcode = 'P0002', message = 'Conexão X ativa não encontrada.';
  end if;

  identity_key := case
    when normalized_twitter_id is not null then 'twitter:' || normalized_twitter_id
    else 'zernio:' || normalized_account_id
  end;
  next_status := case
    when p_needs_reconnect or not p_token_valid then 'needs_reauth'::public.twitter_profile_status
    when not p_can_post then 'offline'::public.twitter_profile_status
    else 'active'::public.twitter_profile_status
  end;

  if normalized_twitter_id is not null then
    select * into profile_row from public.twitter_profiles
    where twitter_user_id = normalized_twitter_id for update;
  end if;
  if profile_row.id is null then
    select profile.* into profile_row
    from public.twitter_profiles profile
    join public.twitter_profile_connection_epochs epoch on epoch.profile_id = profile.id
    where epoch.connection_id = p_connection_id
      and epoch.zernio_account_id = normalized_account_id
      and epoch.ended_at is null
    for update of profile;
  end if;
  if profile_row.id is null then
    select * into profile_row from public.twitter_profiles
    where external_identity_key = identity_key for update;
  end if;

  if profile_row.id is null then
    profile_created := true;
    insert into public.twitter_profiles (
      organization_id, external_identity_key, twitter_user_id, identity_confidence,
      username, display_name, avatar_url, status, account_tier,
      tier_verified_at, can_post, can_fetch_analytics, token_valid,
      needs_reconnect, current_connection_id, health_issues,
      last_health_at, last_synced_at
    ) values (
      p_organization_id, identity_key, normalized_twitter_id,
      case
        when normalized_twitter_id is null then 'zernio_account_id'::public.twitter_identity_confidence
        else 'twitter_user_id'::public.twitter_identity_confidence
      end,
      trim(p_username), nullif(trim(coalesce(p_display_name, '')), ''),
      nullif(trim(coalesce(p_avatar_url, '')), ''), next_status, coalesce(p_account_tier, 'unknown'),
      case when coalesce(p_account_tier, 'unknown') = 'unknown' then null else timezone('utc', now()) end,
      p_can_post, p_can_fetch_analytics, p_token_valid, p_needs_reconnect,
      p_connection_id, coalesce(p_health_issues, '[]'::jsonb), timezone('utc', now()), timezone('utc', now())
    ) returning * into profile_row;
  else
    if profile_row.organization_id <> p_organization_id and profile_row.deleted_at is null then
      raise exception using errcode = '23505', message = 'A identidade deste perfil X não está disponível.';
    end if;
    update public.twitter_profiles
    set organization_id = p_organization_id,
        external_identity_key = identity_key,
        twitter_user_id = coalesce(normalized_twitter_id, twitter_user_id),
        identity_confidence = case
          when normalized_twitter_id is null then identity_confidence
          else 'twitter_user_id'::public.twitter_identity_confidence
        end,
        username = trim(p_username),
        display_name = nullif(trim(coalesce(p_display_name, '')), ''),
        avatar_url = nullif(trim(coalesce(p_avatar_url, '')), ''),
        status = next_status,
        account_tier = coalesce(p_account_tier, 'unknown'),
        tier_verified_at = case when coalesce(p_account_tier, 'unknown') = 'unknown' then tier_verified_at else timezone('utc', now()) end,
        can_post = p_can_post,
        can_fetch_analytics = p_can_fetch_analytics,
        token_valid = p_token_valid,
        needs_reconnect = p_needs_reconnect,
        current_connection_id = p_connection_id,
        health_issues = coalesce(p_health_issues, '[]'::jsonb),
        last_health_at = timezone('utc', now()),
        last_synced_at = timezone('utc', now()),
        deleted_at = null
    where id = profile_row.id
    returning * into profile_row;
  end if;

  select * into epoch_row from public.twitter_profile_connection_epochs
  where profile_id = profile_row.id and ended_at is null
  for update;

  if epoch_row.id is null
    or epoch_row.connection_id <> p_connection_id
    or epoch_row.zernio_account_id <> normalized_account_id
  then
    epoch_changed := epoch_row.id is not null;
    update public.twitter_profile_connection_epochs
    set ended_at = timezone('utc', now()),
        end_reason = 'connection_changed'
    where profile_id = profile_row.id and ended_at is null;

    insert into public.twitter_profile_connection_epochs (
      organization_id, profile_id, connection_id, zernio_account_id, zernio_profile_id
    ) values (
      p_organization_id, profile_row.id, p_connection_id,
      normalized_account_id, connection_row.zernio_profile_id
    ) returning * into epoch_row;
  end if;

  update public.twitter_profiles
  set current_epoch_id = epoch_row.id, current_connection_id = p_connection_id
  where id = profile_row.id
  returning * into profile_row;

  insert into public.twitter_connection_events (
    organization_id, connection_id, profile_id, event_type, message, metadata
  ) values (
    p_organization_id, p_connection_id, profile_row.id,
    case
      when epoch_changed then 'profile_epoch_changed'
      when profile_created then 'profile_connected'
      else 'profile_reauthenticated'
    end,
    'Perfil X sincronizado sem usar username como prova de identidade.',
    jsonb_build_object(
      'identityConfidence', profile_row.identity_confidence,
      'canPost', profile_row.can_post,
      'canFetchAnalytics', profile_row.can_fetch_analytics,
      'needsReconnect', profile_row.needs_reconnect
    )
  );

  return jsonb_build_object(
    'profileId', profile_row.id,
    'epochId', epoch_row.id,
    'epochChanged', epoch_changed,
    'status', profile_row.status,
    'identityConfidence', profile_row.identity_confidence
  );
end;
$$;

create or replace function public.twitter_mark_missing_connection_profiles_offline(
  p_organization_id uuid,
  p_connection_id uuid,
  p_seen_zernio_account_ids text[]
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare affected integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Apenas service_role pode fechar inventário X.';
  end if;
  update public.twitter_profiles profile
  set status = 'offline',
      can_post = false,
      last_synced_at = timezone('utc', now()),
      health_issues = jsonb_build_array('Conta não apareceu no inventário atual da conexão Zernio.')
  from public.twitter_profile_connection_epochs epoch
  where profile.id = epoch.profile_id
    and profile.organization_id = p_organization_id
    and epoch.connection_id = p_connection_id
    and epoch.ended_at is null
    and not (epoch.zernio_account_id = any(coalesce(p_seen_zernio_account_ids, array[]::text[])))
    and profile.deleted_at is null;
  get diagnostics affected = row_count;
  return affected;
end;
$$;

create or replace function public.twitter_soft_delete_connection(
  p_organization_id uuid,
  p_connection_id uuid,
  p_reason text,
  p_actor_user_id uuid,
  p_actor_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  connection_row public.twitter_connections;
  reservation_row record;
  released_total bigint := 0;
  profile_count integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Apenas service_role pode remover conexão X.';
  end if;
  if char_length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception using errcode = '22023', message = 'Motivo obrigatório.';
  end if;
  select * into connection_row from public.twitter_connections
  where id = p_connection_id and organization_id = p_organization_id
  for update;
  if not found then raise exception using errcode = 'P0002', message = 'Conexão não encontrada.'; end if;
  if connection_row.status = 'deleted' then
    return jsonb_build_object('connectionId', p_connection_id, 'idempotentReplay', true, 'releasedMicros', 0);
  end if;

  for reservation_row in
    select id, remaining_micros
    from public.twitter_wallet_reservations
    where connection_id = p_connection_id
      and remaining_micros > 0
      and status in ('open', 'partially_settled')
    for update
  loop
    perform public.twitter_release_wallet_reservation(
      reservation_row.id,
      'connection-delete:' || reservation_row.id::text,
      trim(p_reason),
      false
    );
    released_total := released_total + reservation_row.remaining_micros;
  end loop;

  update public.twitter_profile_connection_epochs
  set ended_at = timezone('utc', now()), end_reason = 'connection_deleted'
  where connection_id = p_connection_id and ended_at is null;

  update public.twitter_profiles
  set status = 'deleted', deleted_at = timezone('utc', now()),
      can_post = false, current_connection_id = null, current_epoch_id = null
  where organization_id = p_organization_id
    and current_connection_id = p_connection_id
    and deleted_at is null;
  get diagnostics profile_count = row_count;

  update public.twitter_connection_oauth_attempts
  set status = 'expired', error_code = 'connection_deleted', error_message = 'Conexão removida.'
  where connection_id = p_connection_id and status = 'pending';

  delete from public.twitter_connection_secrets where connection_id = p_connection_id;
  update public.twitter_connections
  set status = 'deleted', deleted_at = timezone('utc', now()),
      analytics_enabled = false, inbox_enabled = false,
      last_error_code = 'connection_deleted', last_error_message = trim(p_reason)
  where id = p_connection_id;

  insert into public.twitter_connection_events (
    organization_id, connection_id, event_type, actor_user_id, actor_email, message, metadata
  ) values (
    p_organization_id, p_connection_id, 'connection_deleted', p_actor_user_id,
    nullif(trim(coalesce(p_actor_email, '')), ''), trim(p_reason),
    jsonb_build_object('releasedMicros', released_total, 'profilesDeleted', profile_count)
  );

  return jsonb_build_object(
    'connectionId', p_connection_id,
    'idempotentReplay', false,
    'releasedMicros', released_total,
    'profilesDeleted', profile_count,
    'unknownReservationsKept', (
      select count(*) from public.twitter_wallet_reservations
      where connection_id = p_connection_id and status = 'outcome_unknown' and remaining_micros > 0
    )
  );
end;
$$;

alter table public.twitter_profiles enable row level security;
alter table public.twitter_profile_connection_epochs enable row level security;
alter table public.twitter_connection_oauth_attempts enable row level security;
alter table public.twitter_connection_events enable row level security;

create policy twitter_profiles_select_member
on public.twitter_profiles for select to authenticated
using (public.is_organization_member(organization_id));
create policy twitter_profile_connection_epochs_select_member
on public.twitter_profile_connection_epochs for select to authenticated
using (public.is_organization_member(organization_id));
create policy twitter_connection_oauth_attempts_select_admin
on public.twitter_connection_oauth_attempts for select to authenticated
using (public.has_organization_role(organization_id, array['admin']::public.organization_role[]));
create policy twitter_connection_events_select_member
on public.twitter_connection_events for select to authenticated
using (public.is_organization_member(organization_id));

revoke all on table
  public.twitter_profiles,
  public.twitter_profile_connection_epochs,
  public.twitter_connection_oauth_attempts,
  public.twitter_connection_events
from anon;
grant select on table
  public.twitter_profiles,
  public.twitter_profile_connection_epochs,
  public.twitter_connection_events
to authenticated;
grant select on table public.twitter_connection_oauth_attempts to authenticated;
grant select, insert, update, delete on table
  public.twitter_profiles,
  public.twitter_profile_connection_epochs,
  public.twitter_connection_oauth_attempts,
  public.twitter_connection_events
to service_role;

revoke all on function public.twitter_upsert_connection_credentials(uuid, uuid, text, text, text, text, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.twitter_upsert_connection_credentials(uuid, uuid, text, text, text, text, text, text, uuid, text) to service_role;
revoke all on function public.twitter_sync_profile_from_zernio(uuid, uuid, text, text, text, text, text, boolean, boolean, boolean, boolean, public.twitter_account_tier, jsonb) from public, anon, authenticated;
grant execute on function public.twitter_sync_profile_from_zernio(uuid, uuid, text, text, text, text, text, boolean, boolean, boolean, boolean, public.twitter_account_tier, jsonb) to service_role;
revoke all on function public.twitter_mark_missing_connection_profiles_offline(uuid, uuid, text[]) from public, anon, authenticated;
grant execute on function public.twitter_mark_missing_connection_profiles_offline(uuid, uuid, text[]) to service_role;
revoke all on function public.twitter_soft_delete_connection(uuid, uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.twitter_soft_delete_connection(uuid, uuid, text, uuid, text) to service_role;
