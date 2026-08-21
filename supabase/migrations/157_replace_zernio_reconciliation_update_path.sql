-- A função vigente passou a atribuir todos os campos mesmo para mudanças apenas
-- de metadata. Faça UPDATE em dois estágios: campos sem identidade primeiro; os
-- campos de identidade só são alterados se de fato divergirem. Isso mantém as
-- proteções globais e torna o caso canônico idempotente.

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
  canonical_zernio_profile_id text;
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

  select trim(connection.zernio_profile_id) into canonical_zernio_profile_id
  from public.zernio_connections connection
  where connection.id = p_zernio_connection_id
    and connection.organization_id = p_organization_id
    and connection.deleted_at is null
    and nullif(trim(connection.zernio_profile_id), '') is not null
  for key share;
  if not found then
    raise exception using errcode = 'P0002', message = 'Conexão Zernio ativa sem profile canônico não pode reconciliar contas.';
  end if;

  for input_row in select value from jsonb_array_elements(p_rows) loop
    desired_username := nullif(trim(regexp_replace(coalesce(input_row ->> 'username', ''), '^@', '')), '');
    identity_value := lower(desired_username);
    remote_account_id := nullif(trim(input_row ->> 'zernio_account_id'), '');
    desired_zernio_profile_id := nullif(trim(input_row ->> 'zernio_profile_id'), '');

    if desired_zernio_profile_id is distinct from canonical_zernio_profile_id then
      return query select null::uuid, 'conflict'::text,
        'O profileId remoto não pertence à conexão canônica; a atribuição cruzada foi bloqueada.'::text;
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
    select profile.* into existing_profile
    from public.instagram_profiles profile
    where profile.organization_id = p_organization_id
      and profile.provider = 'zernio'
      and profile.zernio_account_id = remote_account_id
    order by (case when profile.deleted_at is null then 0 else 1 end), profile.created_at, profile.id
    limit 1 for update;
    existing_found := found;

    if existing_found and (
      existing_profile.zernio_connection_id <> p_zernio_connection_id
      or existing_profile.zernio_profile_id is distinct from canonical_zernio_profile_id
    ) then
      return query select existing_profile.id, 'conflict'::text,
        'O accountId Zernio já possui vínculo canônico diferente; nenhuma atribuição foi alterada.'::text;
      continue;
    end if;

    if not existing_found then
      existing_profile := null;
      select profile.* into existing_profile
      from public.instagram_profiles profile
      where profile.provider = 'zernio'
        and lower(trim(regexp_replace(profile.username, '^@', ''))) = identity_value
      order by (case when profile.deleted_at is null then 0 else 1 end), profile.created_at, profile.id
      limit 1 for update;
      existing_found := found;
      if existing_found and (
        existing_profile.organization_id <> p_organization_id
        or existing_profile.zernio_connection_id <> p_zernio_connection_id
        or existing_profile.zernio_profile_id is distinct from canonical_zernio_profile_id
      ) then
        return query select existing_profile.id, 'conflict'::text,
          'A identidade Instagram já possui vínculo canônico diferente; nenhuma atribuição foi alterada.'::text;
        continue;
      end if;
    end if;

    if existing_found then
      identity_profile := null;
      select profile.* into identity_profile
      from public.instagram_profiles profile
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
        or existing_profile.zernio_profile_id is distinct from canonical_zernio_profile_id
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
          username = desired_username,
          display_name = desired_display_name,
          profile_picture_url = desired_profile_picture_url,
          account_type = desired_account_type,
          capabilities = desired_capabilities,
          status = desired_status,
          zernio_profile_id = canonical_zernio_profile_id,
          zernio_account_id = remote_account_id,
          zernio_connection_id = p_zernio_connection_id,
          zernio_account_metadata = desired_metadata,
          deleted_at = null
        where id = existing_profile.id returning id into saved_id;
      else
        update public.instagram_profiles set
          display_name = desired_display_name,
          profile_picture_url = desired_profile_picture_url,
          account_type = desired_account_type,
          capabilities = desired_capabilities,
          status = desired_status,
          zernio_account_metadata = desired_metadata
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
      (input_row ->> 'created_by')::uuid, 'zernio', canonical_zernio_profile_id,
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
