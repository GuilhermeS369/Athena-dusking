-- Sincronia Zernio segura: serializa a organização, audita cada chave e nunca
-- substitui silenciosamente a identidade Instagram já pertencente a outra chave.

create type public.zernio_sync_batch_status as enum (
  'processing', 'completed', 'completed_with_errors', 'failed'
);

create type public.zernio_sync_log_status as enum (
  'succeeded', 'failed', 'conflict'
);

create table public.zernio_organization_sync_locks (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  locked_by uuid not null,
  requested_by uuid not null references auth.users(id) on delete restrict,
  locked_until timestamptz not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create trigger zernio_organization_sync_locks_set_updated_at
before update on public.zernio_organization_sync_locks
for each row execute function public.set_updated_at();

create table public.zernio_sync_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  requested_by uuid not null references auth.users(id) on delete restrict,
  lock_holder uuid not null,
  status public.zernio_sync_batch_status not null default 'processing',
  total_connections integer not null default 0 check (total_connections >= 0),
  synced_count integer not null default 0 check (synced_count >= 0),
  conflict_count integer not null default 0 check (conflict_count >= 0),
  failure_count integer not null default 0 check (failure_count >= 0),
  error_message text,
  created_at timestamptz not null default timezone('utc', now()),
  completed_at timestamptz
);

create index zernio_sync_batches_org_created_idx
on public.zernio_sync_batches (organization_id, created_at desc);

create table public.zernio_sync_log_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  batch_id uuid references public.zernio_sync_batches(id) on delete cascade,
  zernio_connection_id uuid references public.zernio_connections(id) on delete set null,
  zernio_account_id text,
  instagram_identity text,
  status public.zernio_sync_log_status not null,
  synced_count integer not null default 0 check (synced_count >= 0),
  error_code text,
  error_message text,
  conflict_profile_id uuid references public.instagram_profiles(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now())
);

create index zernio_sync_log_items_org_created_idx
on public.zernio_sync_log_items (organization_id, created_at desc);
create index zernio_sync_log_items_connection_created_idx
on public.zernio_sync_log_items (zernio_connection_id, created_at desc);

create table public.zernio_profile_duplicate_resolutions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  normalized_username text not null,
  retained_profile_id uuid not null references public.instagram_profiles(id) on delete restrict,
  suppressed_profile_id uuid not null references public.instagram_profiles(id) on delete restrict,
  reason text not null,
  resolved_at timestamptz not null default timezone('utc', now()),
  unique (suppressed_profile_id)
);

-- Protege também fluxos futuros que não utilizem a RPC de reconciliação.
create or replace function public.prevent_zernio_instagram_identity_conflict()
returns trigger language plpgsql security definer set search_path = public as $$
declare identity_value text;
begin
  if new.provider <> 'zernio' or new.deleted_at is not null then return new; end if;
  identity_value := lower(nullif(trim(regexp_replace(new.username, '^@', '')), ''));
  if identity_value is null then raise exception 'Identidade Instagram Zernio inválida.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(identity_value, 0));
  if exists (
    select 1 from public.instagram_profiles profile
    where profile.provider = 'zernio' and profile.deleted_at is null and profile.id <> new.id
      and lower(trim(regexp_replace(profile.username, '^@', ''))) = identity_value
  ) then
    raise exception using errcode = '23505', message = 'A identidade Instagram já está vinculada a outra conexão ou organização; resolva o conflito explicitamente.';
  end if;
  return new;
end;
$$;

create trigger instagram_profiles_prevent_zernio_identity_conflict
before insert or update of username, provider, deleted_at on public.instagram_profiles
for each row execute function public.prevent_zernio_instagram_identity_conflict();

create or replace function public.acquire_zernio_organization_sync_lock(
  p_organization_id uuid,
  p_locked_by uuid,
  p_requested_by uuid,
  p_lease_seconds integer default 300
)
returns boolean language plpgsql security definer set search_path = public as $$
declare claimed boolean;
begin
  insert into public.zernio_organization_sync_locks (organization_id, locked_by, requested_by, locked_until)
  values (p_organization_id, p_locked_by, p_requested_by, timezone('utc', now()) + make_interval(secs => greatest(60, least(coalesce(p_lease_seconds, 300), 900))))
  on conflict (organization_id) do update set
    locked_by = excluded.locked_by,
    requested_by = excluded.requested_by,
    locked_until = excluded.locked_until,
    updated_at = timezone('utc', now())
  where public.zernio_organization_sync_locks.locked_until <= timezone('utc', now())
  returning true into claimed;
  return coalesce(claimed, false);
end;
$$;

create or replace function public.release_zernio_organization_sync_lock(
  p_organization_id uuid,
  p_locked_by uuid
)
returns boolean language plpgsql security definer set search_path = public as $$
declare released boolean;
begin
  delete from public.zernio_organization_sync_locks
  where organization_id = p_organization_id and locked_by = p_locked_by
  returning true into released;
  return coalesce(released, false);
end;
$$;

-- A função usa a identidade normalizada pelo username porque a Zernio pode
-- atribuir accountIds distintos à mesma conta Instagram em API keys diferentes.
-- Nenhum conflito é sobrescrito: o registro vencedor existente permanece intacto.
create or replace function public.reconcile_zernio_connection_accounts(
  p_organization_id uuid,
  p_zernio_connection_id uuid,
  p_rows jsonb
)
returns table(profile_id uuid, result_status text, conflict_reason text)
language plpgsql security definer set search_path = public as $$
declare
  input_row jsonb;
  identity_value text;
  remote_account_id text;
  existing_profile public.instagram_profiles%rowtype;
  saved_id uuid;
begin
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'Linhas de sincronização inválidas.'; end if;
  if not exists (select 1 from public.zernio_connections where id = p_zernio_connection_id and organization_id = p_organization_id and deleted_at is null) then
    raise exception 'Conexão Zernio ativa não encontrada para a organização.';
  end if;

  for input_row in select value from jsonb_array_elements(p_rows) loop
    identity_value := lower(nullif(trim(regexp_replace(coalesce(input_row ->> 'username', ''), '^@', '')), ''));
    remote_account_id := nullif(trim(input_row ->> 'zernio_account_id'), '');
    if identity_value is null or remote_account_id is null then
      return query select null::uuid, 'conflict'::text, 'A Zernio não retornou identidade Instagram ou accountId válido.'::text;
      continue;
    end if;

    perform pg_advisory_xact_lock(hashtextextended(identity_value, 0));

    select * into existing_profile
    from public.instagram_profiles
    where provider = 'zernio' and deleted_at is null
      and lower(trim(regexp_replace(username, '^@', ''))) = identity_value
    order by created_at, id
    limit 1 for update;

    if found and (existing_profile.organization_id <> p_organization_id or existing_profile.zernio_connection_id <> p_zernio_connection_id) then
      return query select existing_profile.id, 'conflict'::text,
        case when existing_profile.organization_id <> p_organization_id
          then 'A identidade Instagram já pertence a outra organização; aprovação explícita é obrigatória.'
          else 'A identidade Instagram já pertence a outra chave Zernio desta organização; aprovação explícita é obrigatória.' end;
      continue;
    end if;

    if found then
      update public.instagram_profiles set
        instagram_user_id = 'zernio:' || remote_account_id,
        username = input_row ->> 'username', display_name = input_row ->> 'display_name',
        profile_picture_url = input_row ->> 'profile_picture_url', account_type = input_row ->> 'account_type',
        capabilities = coalesce(input_row -> 'capabilities', '{}'::jsonb), status = coalesce((input_row ->> 'status')::public.instagram_profile_status, 'online'),
        zernio_profile_id = input_row ->> 'zernio_profile_id', zernio_account_id = remote_account_id,
        zernio_connection_id = p_zernio_connection_id, zernio_account_metadata = coalesce(input_row -> 'zernio_account_metadata', '{}'::jsonb),
        deleted_at = null
      where id = existing_profile.id returning id into saved_id;
    else
      insert into public.instagram_profiles (
        organization_id, instagram_user_id, username, display_name, profile_picture_url, account_type, capabilities,
        encrypted_access_token, token_expires_at, status, created_by, provider, zernio_profile_id, zernio_account_id,
        zernio_connection_id, zernio_account_metadata
      ) values (
        p_organization_id, 'zernio:' || remote_account_id, input_row ->> 'username', input_row ->> 'display_name',
        input_row ->> 'profile_picture_url', input_row ->> 'account_type', coalesce(input_row -> 'capabilities', '{}'::jsonb),
        null, null, coalesce((input_row ->> 'status')::public.instagram_profile_status, 'online'),
        (input_row ->> 'created_by')::uuid, 'zernio', input_row ->> 'zernio_profile_id', remote_account_id,
        p_zernio_connection_id, coalesce(input_row -> 'zernio_account_metadata', '{}'::jsonb)
      ) returning id into saved_id;
    end if;
    return query select saved_id, 'synced'::text, null::text;
  end loop;
end;
$$;

-- Correção reversível de registros já comprovadamente redundantes: mantém o
-- primeiro perfil como canônico e apenas faz soft delete dos demais. Nenhuma
-- publicação, grupo, mídia, tentativa ou FK é apagada ou reatribuída.
create or replace function public.resolve_zernio_duplicate_username(
  p_organization_id uuid,
  p_username text,
  p_reason text default 'Duplicidade confirmada por listagem Zernio em duas chaves.'
)
returns table(retained_profile_id uuid, suppressed_profile_ids uuid[])
language plpgsql security definer set search_path = public as $$
declare
  identity_value text := lower(nullif(trim(regexp_replace(p_username, '^@', '')), ''));
  retained_id uuid;
  duplicate_id uuid;
  suppressed uuid[] := '{}'::uuid[];
begin
  if identity_value is null then raise exception 'Username inválido.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(identity_value, 0));
  select id into retained_id from public.instagram_profiles
  where organization_id = p_organization_id and provider = 'zernio' and deleted_at is null
    and lower(trim(regexp_replace(username, '^@', ''))) = identity_value
  order by created_at, id limit 1 for update;
  if retained_id is null then raise exception 'Nenhum perfil Zernio ativo encontrado para %.', identity_value; end if;
  for duplicate_id in select id from public.instagram_profiles
    where organization_id = p_organization_id and provider = 'zernio' and deleted_at is null and id <> retained_id
      and lower(trim(regexp_replace(username, '^@', ''))) = identity_value
    order by created_at, id for update
  loop
    update public.instagram_profiles set deleted_at = timezone('utc', now()), last_error_code = 'zernio_duplicate_identity_suppressed', last_error_message = 'Registro local redundante suprimido sem apagar publicações ou grupos.' where id = duplicate_id;
    insert into public.zernio_profile_duplicate_resolutions (organization_id, normalized_username, retained_profile_id, suppressed_profile_id, reason)
    values (p_organization_id, identity_value, retained_id, duplicate_id, left(p_reason, 1200)) on conflict (suppressed_profile_id) do nothing;
    suppressed := array_append(suppressed, duplicate_id);
  end loop;
  return query select retained_id, suppressed;
end;
$$;

-- O screenshot e a listagem remota confirmaram duas entradas Athena para a
-- mesma identidade em chaves distintas desta organização. A correção é soft
-- delete somente do redundante; dados dependentes são preservados intactos.
do $$
begin
  if exists (
    select 1 from public.instagram_profiles
    where organization_id = '695be08f-3084-4046-a91d-9052b2a1582b'::uuid
      and provider = 'zernio' and deleted_at is null
      and lower(trim(regexp_replace(username, '^@', ''))) = 'erishimizu67'
    having count(*) > 1
  ) then
    perform public.resolve_zernio_duplicate_username(
      '695be08f-3084-4046-a91d-9052b2a1582b'::uuid,
      'erishimizu67',
      'Duplicidade confirmada: CasperAshmon2315 e ChrissyMurtaza780312 retornam @erishimizu67 com accountIds remotos distintos.'
    );
  end if;
end;
$$;

revoke all on public.zernio_organization_sync_locks, public.zernio_sync_batches, public.zernio_sync_log_items, public.zernio_profile_duplicate_resolutions from public, anon, authenticated;
grant all on public.zernio_organization_sync_locks, public.zernio_sync_batches, public.zernio_sync_log_items, public.zernio_profile_duplicate_resolutions to service_role;
revoke all on function public.acquire_zernio_organization_sync_lock(uuid, uuid, uuid, integer), public.release_zernio_organization_sync_lock(uuid, uuid), public.reconcile_zernio_connection_accounts(uuid, uuid, jsonb), public.resolve_zernio_duplicate_username(uuid, text, text) from public, anon, authenticated;
grant execute on function public.acquire_zernio_organization_sync_lock(uuid, uuid, uuid, integer), public.release_zernio_organization_sync_lock(uuid, uuid), public.reconcile_zernio_connection_accounts(uuid, uuid, jsonb), public.resolve_zernio_duplicate_username(uuid, text, text) to service_role;
