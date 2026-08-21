-- Cada autorização móvel recebe um profile remoto Zernio exclusivo. Assim,
-- vários aparelhos podem abrir o Instagram ao mesmo tempo sem a Zernio
-- sobrescrever o accountId de outro aparelho. A FIFO continua exclusivamente
-- na finalização pós-callback (migration 160).

drop index if exists public.zernio_oauth_turns_one_active_connection_idx;

create table public.zernio_connection_remote_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  zernio_connection_id uuid not null references public.zernio_connections(id) on delete cascade,
  zernio_profile_id text not null,
  profile_name text,
  kind text not null check (kind in ('canonical', 'dedicated')),
  status text not null default 'available' check (status in ('available', 'claimed', 'connected', 'retired', 'cleanup_pending')),
  claimed_by_attempt_id uuid references public.zernio_connection_attempts(id) on delete set null,
  claimed_at timestamptz,
  connected_at timestamptz,
  released_at timestamptz,
  release_reason text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique(zernio_connection_id, zernio_profile_id),
  unique(claimed_by_attempt_id),
  check (char_length(trim(zernio_profile_id)) between 1 and 160)
);

create unique index zernio_remote_profiles_global_owner_idx
  on public.zernio_connection_remote_profiles(zernio_profile_id);
create index zernio_remote_profiles_pool_idx
  on public.zernio_connection_remote_profiles(organization_id, zernio_connection_id, status, created_at);

insert into public.zernio_connection_remote_profiles (
  organization_id, zernio_connection_id, zernio_profile_id, profile_name, kind, status
)
select connection.organization_id, connection.id, trim(connection.zernio_profile_id),
       connection.label, 'canonical',
       case when exists (
         select 1 from public.instagram_profiles profile
         where profile.organization_id = connection.organization_id
           and profile.provider = 'zernio'
           and profile.zernio_connection_id = connection.id
           and profile.deleted_at is null
       ) then 'connected' else 'available' end
from public.zernio_connections connection
where connection.deleted_at is null
  and nullif(trim(connection.zernio_profile_id), '') is not null
on conflict (zernio_connection_id, zernio_profile_id) do nothing;

alter table public.zernio_connection_remote_profiles enable row level security;
revoke all on public.zernio_connection_remote_profiles from public, anon, authenticated;
grant all on public.zernio_connection_remote_profiles to service_role;

create or replace function public.claim_zernio_attempt_remote_profile(
  p_attempt_id uuid,
  p_canonical_has_account boolean default false
)
returns table(zernio_profile_id text, profile_name text, profile_kind text)
language plpgsql security definer set search_path = public as $$
declare selected public.zernio_connection_attempts%rowtype;
declare claimed public.zernio_connection_remote_profiles%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;

  select * into selected from public.zernio_connection_attempts
  where id = p_attempt_id and status = 'started' for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Attempt Zernio não encontrado ou já iniciado.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    selected.organization_id::text || ':zernio-remote-profile:' || selected.zernio_connection_id::text, 0
  ));

  update public.zernio_connection_remote_profiles remote_profile
  set status = 'connected', connected_at = coalesce(connected_at, timezone('utc', now())),
      updated_at = timezone('utc', now())
  where remote_profile.zernio_connection_id = selected.zernio_connection_id
    and remote_profile.kind = 'canonical'
    and p_canonical_has_account
    and remote_profile.status = 'available';

  select * into claimed
  from public.zernio_connection_remote_profiles remote_profile
  where remote_profile.organization_id = selected.organization_id
    and remote_profile.zernio_connection_id = selected.zernio_connection_id
    and remote_profile.status = 'available'
    and (remote_profile.kind = 'dedicated' or not p_canonical_has_account)
  order by case when remote_profile.kind = 'canonical' then 0 else 1 end,
           remote_profile.created_at, remote_profile.id
  for update skip locked limit 1;

  if found then
    update public.zernio_connection_remote_profiles remote_profile
    set status = 'claimed', claimed_by_attempt_id = selected.id,
        claimed_at = timezone('utc', now()), released_at = null,
        release_reason = null, updated_at = timezone('utc', now())
    where remote_profile.id = claimed.id
    returning remote_profile.* into claimed;
    zernio_profile_id := claimed.zernio_profile_id;
    profile_name := claimed.profile_name;
    profile_kind := claimed.kind;
    return next;
  end if;
end;
$$;

create or replace function public.register_zernio_attempt_remote_profile(
  p_attempt_id uuid,
  p_zernio_profile_id text,
  p_profile_name text
)
returns boolean language plpgsql security definer set search_path = public as $$
declare selected public.zernio_connection_attempts%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;
  if nullif(trim(p_zernio_profile_id), '') is null then
    raise exception using errcode = '22023', message = 'profileId remoto inválido.';
  end if;
  select * into selected from public.zernio_connection_attempts
  where id = p_attempt_id and status = 'started' for update;
  if not found then raise exception using errcode = 'P0002', message = 'Attempt Zernio não encontrado.'; end if;

  insert into public.zernio_connection_remote_profiles (
    organization_id, zernio_connection_id, zernio_profile_id, profile_name,
    kind, status, claimed_by_attempt_id, claimed_at
  ) values (
    selected.organization_id, selected.zernio_connection_id, trim(p_zernio_profile_id),
    nullif(trim(p_profile_name), ''), 'dedicated', 'claimed', selected.id, timezone('utc', now())
  );
  return true;
end;
$$;

create or replace function public.release_zernio_attempt_remote_profile(
  p_attempt_id uuid,
  p_reason text
)
returns boolean language plpgsql security definer set search_path = public as $$
declare released boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;
  update public.zernio_connection_remote_profiles remote_profile
  set status = case when kind = 'canonical' then 'available' else 'cleanup_pending' end,
      claimed_by_attempt_id = null, released_at = timezone('utc', now()),
      release_reason = left(coalesce(p_reason, 'released'), 200),
      updated_at = timezone('utc', now())
  where remote_profile.claimed_by_attempt_id = p_attempt_id
    and remote_profile.status = 'claimed'
  returning true into released;
  return coalesce(released, false);
end;
$$;

create or replace function public.mark_zernio_attempt_remote_profile_connected(
  p_attempt_id uuid
)
returns boolean language plpgsql security definer set search_path = public as $$
declare changed boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;
  update public.zernio_connection_remote_profiles remote_profile
  set status = 'connected', connected_at = timezone('utc', now()),
      updated_at = timezone('utc', now())
  where remote_profile.claimed_by_attempt_id = p_attempt_id
    and remote_profile.status = 'claimed'
  returning true into changed;
  return coalesce(changed, false);
end;
$$;

revoke all on function public.claim_zernio_attempt_remote_profile(uuid, boolean) from public, anon, authenticated;
revoke all on function public.register_zernio_attempt_remote_profile(uuid, text, text) from public, anon, authenticated;
revoke all on function public.release_zernio_attempt_remote_profile(uuid, text) from public, anon, authenticated;
revoke all on function public.mark_zernio_attempt_remote_profile_connected(uuid) from public, anon, authenticated;
grant execute on function public.claim_zernio_attempt_remote_profile(uuid, boolean) to service_role;
grant execute on function public.register_zernio_attempt_remote_profile(uuid, text, text) to service_role;
grant execute on function public.release_zernio_attempt_remote_profile(uuid, text) to service_role;
grant execute on function public.mark_zernio_attempt_remote_profile_connected(uuid) to service_role;

-- A conexão continua sendo a fronteira da API key; o profile remoto pode ser o
-- canônico ou qualquer profile dedicado registrado para essa mesma conexão.
create or replace function public.enforce_zernio_profile_connection_pair()
returns trigger language plpgsql set search_path = public as $$
declare connection_row public.zernio_connections%rowtype;
begin
  if new.provider <> 'zernio' then return new; end if;
  if new.zernio_connection_id is null
     or nullif(trim(coalesce(new.zernio_profile_id, '')), '') is null
     or nullif(trim(coalesce(new.zernio_account_id, '')), '') is null then
    raise exception using errcode = '23514', message = 'Perfil Zernio exige conexão, profileId e accountId canônicos.';
  end if;
  select * into connection_row from public.zernio_connections connection
  where connection.id = new.zernio_connection_id
    and connection.organization_id = new.organization_id
    and connection.deleted_at is null for key share;
  if not found then
    raise exception using errcode = '23514', message = 'A conexão Zernio não pertence à organização do perfil.';
  end if;
  if not exists (
    select 1 from public.zernio_connection_remote_profiles remote_profile
    where remote_profile.organization_id = new.organization_id
      and remote_profile.zernio_connection_id = new.zernio_connection_id
      and remote_profile.zernio_profile_id = trim(new.zernio_profile_id)
      and remote_profile.status in ('claimed', 'connected')
  ) then
    raise exception using errcode = '23514', message = 'O profileId remoto não pertence à conexão Zernio informada.';
  end if;
  new.zernio_profile_id := trim(new.zernio_profile_id);
  new.zernio_account_id := trim(new.zernio_account_id);
  return new;
end;
$$;

-- A reconciliação da migration 157 continua válida quando o profile permitido
-- é obtido da própria linha, em vez de forçado para o profile principal.
-- A trigger acima mantém a proteção contra atribuição entre chaves.
create or replace function public.zernio_profile_belongs_to_connection(
  p_organization_id uuid, p_connection_id uuid, p_profile_id text
)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.zernio_connection_remote_profiles remote_profile
    where remote_profile.organization_id = p_organization_id
      and remote_profile.zernio_connection_id = p_connection_id
      and remote_profile.zernio_profile_id = trim(p_profile_id)
      and remote_profile.status in ('claimed', 'connected')
  );
$$;

revoke all on function public.zernio_profile_belongs_to_connection(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.zernio_profile_belongs_to_connection(uuid, uuid, text) to service_role;

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
  desired_username text;
  desired_display_name text;
  desired_profile_picture_url text;
  desired_account_type text;
  desired_capabilities jsonb;
  desired_status public.instagram_profile_status;
  desired_zernio_profile_id text;
  desired_metadata jsonb;
  existing_profile public.instagram_profiles%rowtype;
  identity_profile public.instagram_profiles%rowtype;
  saved_id uuid;
  existing_found boolean := false;
  changed boolean;
  identity_changed boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception using errcode = '22023', message = 'Linhas de sincronização inválidas.';
  end if;

  if not exists (
    select 1 from public.zernio_connections connection
    where connection.id = p_zernio_connection_id
      and connection.organization_id = p_organization_id
      and connection.deleted_at is null
  ) then
    raise exception using errcode = 'P0002', message = 'Conexão Zernio ativa não encontrada.';
  end if;

  for input_row in select value from jsonb_array_elements(p_rows) loop
    desired_username := nullif(trim(regexp_replace(coalesce(input_row ->> 'username', ''), '^@', '')), '');
    identity_value := lower(desired_username);
    remote_account_id := nullif(trim(input_row ->> 'zernio_account_id'), '');
    desired_zernio_profile_id := nullif(trim(input_row ->> 'zernio_profile_id'), '');

    if desired_zernio_profile_id is null or not public.zernio_profile_belongs_to_connection(
      p_organization_id, p_zernio_connection_id, desired_zernio_profile_id
    ) then
      return query select null::uuid, 'conflict'::text,
        'O profileId remoto não pertence à conexão; a atribuição cruzada foi bloqueada.'::text;
      continue;
    end if;
    if identity_value is null or remote_account_id is null then
      return query select null::uuid, 'conflict'::text,
        'A Zernio não retornou identidade Instagram ou accountId válido.'::text;
      continue;
    end if;

    perform pg_advisory_xact_lock(hashtextextended('zernio-account:' || p_organization_id::text || ':' || remote_account_id, 0));
    perform pg_advisory_xact_lock(hashtextextended('zernio-identity:' || identity_value, 0));

    existing_profile := null;
    select profile.* into existing_profile from public.instagram_profiles profile
    where profile.organization_id = p_organization_id
      and profile.provider = 'zernio'
      and profile.zernio_account_id = remote_account_id
    order by (case when profile.deleted_at is null then 0 else 1 end), profile.created_at, profile.id
    limit 1 for update;
    existing_found := found;

    if existing_found and (
      existing_profile.zernio_connection_id <> p_zernio_connection_id
      or existing_profile.zernio_profile_id is distinct from desired_zernio_profile_id
    ) then
      return query select existing_profile.id, 'conflict'::text,
        'O accountId Zernio já possui vínculo canônico diferente; nenhuma atribuição foi alterada.'::text;
      continue;
    end if;

    if not existing_found then
      existing_profile := null;
      select profile.* into existing_profile from public.instagram_profiles profile
      where profile.provider = 'zernio'
        and lower(trim(regexp_replace(profile.username, '^@', ''))) = identity_value
      order by (case when profile.deleted_at is null then 0 else 1 end), profile.created_at, profile.id
      limit 1 for update;
      existing_found := found;
      if existing_found and (
        existing_profile.organization_id <> p_organization_id
        or existing_profile.zernio_connection_id <> p_zernio_connection_id
        or existing_profile.zernio_profile_id is distinct from desired_zernio_profile_id
      ) then
        return query select existing_profile.id, 'conflict'::text,
          'A identidade Instagram já possui vínculo canônico diferente; nenhuma atribuição foi alterada.'::text;
        continue;
      end if;
    end if;

    if existing_found then
      identity_profile := null;
      select profile.* into identity_profile from public.instagram_profiles profile
      where profile.provider = 'zernio' and profile.deleted_at is null
        and profile.id <> existing_profile.id
        and lower(trim(regexp_replace(profile.username, '^@', ''))) = identity_value
      order by profile.created_at, profile.id limit 1 for update;
      if found then
        return query select identity_profile.id, 'conflict'::text,
          'A identidade Instagram já pertence a outro perfil ativo; nenhuma atribuição foi alterada.'::text;
        continue;
      end if;
    end if;

    desired_display_name := input_row ->> 'display_name';
    desired_profile_picture_url := input_row ->> 'profile_picture_url';
    desired_account_type := input_row ->> 'account_type';
    desired_capabilities := coalesce(input_row -> 'capabilities', '{}'::jsonb);
    desired_status := coalesce(nullif(input_row ->> 'status', '')::public.instagram_profile_status, 'online');
    desired_metadata := coalesce(input_row -> 'zernio_account_metadata', '{}'::jsonb);

    if existing_found then
      identity_changed := existing_profile.deleted_at is not null
        or existing_profile.instagram_user_id is distinct from 'zernio:' || remote_account_id
        or lower(trim(regexp_replace(existing_profile.username, '^@', ''))) is distinct from identity_value
        or existing_profile.zernio_profile_id is distinct from desired_zernio_profile_id
        or existing_profile.zernio_account_id is distinct from remote_account_id
        or existing_profile.zernio_connection_id is distinct from p_zernio_connection_id;
      changed := identity_changed
        or existing_profile.display_name is distinct from desired_display_name
        or existing_profile.profile_picture_url is distinct from desired_profile_picture_url
        or existing_profile.account_type is distinct from desired_account_type
        or existing_profile.capabilities is distinct from desired_capabilities
        or existing_profile.status is distinct from desired_status
        or existing_profile.zernio_account_metadata is distinct from desired_metadata;

      if not changed then
        return query select existing_profile.id, 'unchanged'::text, null::text;
        continue;
      end if;
      if identity_changed then
        update public.instagram_profiles set
          instagram_user_id = 'zernio:' || remote_account_id,
          username = desired_username, display_name = desired_display_name,
          profile_picture_url = desired_profile_picture_url, account_type = desired_account_type,
          capabilities = desired_capabilities, status = desired_status,
          zernio_profile_id = desired_zernio_profile_id, zernio_account_id = remote_account_id,
          zernio_connection_id = p_zernio_connection_id, zernio_account_metadata = desired_metadata,
          deleted_at = null
        where id = existing_profile.id returning id into saved_id;
      else
        update public.instagram_profiles set
          display_name = desired_display_name, profile_picture_url = desired_profile_picture_url,
          account_type = desired_account_type, capabilities = desired_capabilities,
          status = desired_status, zernio_account_metadata = desired_metadata
        where id = existing_profile.id returning id into saved_id;
      end if;
      return query select saved_id, 'updated'::text, null::text;
      continue;
    end if;

    insert into public.instagram_profiles (
      organization_id, instagram_user_id, username, display_name, profile_picture_url,
      account_type, capabilities, encrypted_access_token, token_expires_at, status,
      created_by, provider, zernio_profile_id, zernio_account_id,
      zernio_connection_id, zernio_account_metadata
    ) values (
      p_organization_id, 'zernio:' || remote_account_id, desired_username,
      desired_display_name, desired_profile_picture_url, desired_account_type,
      desired_capabilities, null, null, desired_status,
      (input_row ->> 'created_by')::uuid, 'zernio', desired_zernio_profile_id,
      remote_account_id, p_zernio_connection_id, desired_metadata
    ) returning id into saved_id;
    return query select saved_id, 'created'::text, null::text;
  end loop;
end;
$$;

revoke all on function public.reconcile_zernio_connection_accounts(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.reconcile_zernio_connection_accounts(uuid, uuid, jsonb)
  to service_role;

notify pgrst, 'reload schema';
