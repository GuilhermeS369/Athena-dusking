-- Fix zernio reconciliation to recover soft-deleted profiles instead of
-- attempting to insert and violating unique constraints.

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
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception using errcode = '22023', message = 'Linhas de sincronização inválidas.';
  end if;
  if not exists (
    select 1
    from public.zernio_connections
    where id = p_zernio_connection_id
      and organization_id = p_organization_id
      and deleted_at is null
  ) then
    raise exception using errcode = 'P0002', message = 'Conexão Zernio ativa não encontrada para a organização.';
  end if;

  for input_row in select value from jsonb_array_elements(p_rows) loop
    desired_username := nullif(trim(regexp_replace(coalesce(input_row ->> 'username', ''), '^@', '')), '');
    identity_value := lower(desired_username);
    remote_account_id := nullif(trim(input_row ->> 'zernio_account_id'), '');

    if identity_value is null or remote_account_id is null then
      return query select null::uuid, 'conflict'::text, 'A Zernio não retornou identidade Instagram ou accountId válido.'::text;
      continue;
    end if;

    perform pg_advisory_xact_lock(hashtextextended(identity_value, 0));
    perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':' || remote_account_id, 0));

    existing_profile := null;
    select profile.* into existing_profile
    from public.instagram_profiles profile
    where profile.organization_id = p_organization_id
      and profile.provider = 'zernio'
      and profile.zernio_account_id = remote_account_id
    order by (case when profile.deleted_at is null then 0 else 1 end), profile.created_at, profile.id
    limit 1
    for update;
    existing_found := found;

    if existing_found and existing_profile.zernio_connection_id <> p_zernio_connection_id then
      return query select existing_profile.id, 'conflict'::text,
        'O accountId Zernio já está vinculado a outra chave desta organização; a correção exige reconciliação explícita.'::text;
      continue;
    end if;

    if not existing_found then
      existing_profile := null;
      select profile.* into existing_profile
      from public.instagram_profiles profile
      where profile.provider = 'zernio'
        and lower(trim(regexp_replace(profile.username, '^@', ''))) = identity_value
      order by (case when profile.deleted_at is null then 0 else 1 end), profile.created_at, profile.id
      limit 1
      for update;
      existing_found := found;

      if existing_found and (
        existing_profile.organization_id <> p_organization_id
        or existing_profile.zernio_connection_id <> p_zernio_connection_id
      ) then
        return query select existing_profile.id, 'conflict'::text,
          case
            when existing_profile.organization_id <> p_organization_id
              then 'A identidade Instagram já pertence a outra organização; aprovação explícita é obrigatória.'
            else 'A identidade Instagram já pertence a outra chave Zernio desta organização; aprovação explícita é obrigatória.'
          end;
        continue;
      end if;
    end if;

    if existing_found then
      identity_profile := null;
      select profile.* into identity_profile
      from public.instagram_profiles profile
      where profile.provider = 'zernio'
        and profile.deleted_at is null
        and profile.id <> existing_profile.id
        and lower(trim(regexp_replace(profile.username, '^@', ''))) = identity_value
      order by profile.created_at, profile.id
      limit 1
      for update;

      if found then
        return query select identity_profile.id, 'conflict'::text,
          case
            when identity_profile.organization_id <> p_organization_id
              then 'A nova identidade Instagram já pertence a outra organização; aprovação explícita é obrigatória.'
            else 'A nova identidade Instagram já pertence a outra chave Zernio desta organização; aprovação explícita é obrigatória.'
          end;
        continue;
      end if;
    end if;

    desired_display_name := input_row ->> 'display_name';
    desired_profile_picture_url := input_row ->> 'profile_picture_url';
    desired_account_type := input_row ->> 'account_type';
    desired_capabilities := coalesce(input_row -> 'capabilities', '{}'::jsonb);
    desired_status := coalesce(nullif(input_row ->> 'status', '')::public.instagram_profile_status, 'online');
    desired_zernio_profile_id := input_row ->> 'zernio_profile_id';
    desired_metadata := coalesce(input_row -> 'zernio_account_metadata', '{}'::jsonb);

    if existing_found then
      changed :=
        existing_profile.deleted_at is not null
        or existing_profile.instagram_user_id is distinct from 'zernio:' || remote_account_id
        or existing_profile.username is distinct from desired_username
        or existing_profile.display_name is distinct from desired_display_name
        or existing_profile.profile_picture_url is distinct from desired_profile_picture_url
        or existing_profile.account_type is distinct from desired_account_type
        or existing_profile.capabilities is distinct from desired_capabilities
        or existing_profile.status is distinct from desired_status
        or existing_profile.zernio_profile_id is distinct from desired_zernio_profile_id
        or existing_profile.zernio_account_id is distinct from remote_account_id
        or existing_profile.zernio_connection_id is distinct from p_zernio_connection_id
        or existing_profile.zernio_account_metadata is distinct from desired_metadata;

      if changed then
        update public.instagram_profiles set
          instagram_user_id = 'zernio:' || remote_account_id,
          username = desired_username,
          display_name = desired_display_name,
          profile_picture_url = desired_profile_picture_url,
          account_type = desired_account_type,
          capabilities = desired_capabilities,
          status = desired_status,
          zernio_profile_id = desired_zernio_profile_id,
          zernio_account_id = remote_account_id,
          zernio_connection_id = p_zernio_connection_id,
          zernio_account_metadata = desired_metadata,
          deleted_at = null
        where id = existing_profile.id
        returning id into saved_id;

        return query select saved_id, 'updated'::text, null::text;
      else
        return query select existing_profile.id, 'unchanged'::text, null::text;
      end if;
    else
      insert into public.instagram_profiles (
        organization_id, instagram_user_id, username, display_name,
        profile_picture_url, account_type, capabilities,
        encrypted_access_token, token_expires_at, status, created_by, provider,
        zernio_profile_id, zernio_account_id, zernio_connection_id,
        zernio_account_metadata
      ) values (
        p_organization_id, 'zernio:' || remote_account_id, desired_username,
        desired_display_name, desired_profile_picture_url, desired_account_type,
        desired_capabilities, null, null, desired_status,
        (input_row ->> 'created_by')::uuid, 'zernio',
        desired_zernio_profile_id, remote_account_id,
        p_zernio_connection_id, desired_metadata
      ) returning id into saved_id;

      return query select saved_id, 'created'::text, null::text;
    end if;
  end loop;
end;
$$;

revoke all on function public.reconcile_zernio_connection_accounts(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.reconcile_zernio_connection_accounts(uuid, uuid, jsonb) to service_role;
