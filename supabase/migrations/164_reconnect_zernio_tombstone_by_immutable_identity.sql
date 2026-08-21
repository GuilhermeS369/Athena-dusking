-- Permite reativar um perfil Zernio removido somente quando a conta recém-
-- autorizada comprova a mesma identidade imutável do Instagram. Username,
-- accountId e profileId, isoladamente, nunca autorizam a reassociação.

create or replace function public.zernio_instagram_immutable_identity(
  p_metadata jsonb
)
returns text
language sql
immutable
set search_path = public
as $$
  select nullif(trim(coalesce(
    p_metadata ->> 'platformUserId',
    p_metadata #>> '{metadata,platformUserId}',
    p_metadata #>> '{metadata,instagramScopedId}',
    p_metadata #>> '{metadata,profileData,instagramScopedId}',
    p_metadata #>> '{metadata,profileData,id}',
    p_metadata #>> '{profileData,instagramScopedId}',
    p_metadata #>> '{profileData,id}'
  )), '');
$$;

revoke all on function public.zernio_instagram_immutable_identity(jsonb)
  from public, anon, authenticated;

-- A guarda estrutural passa a considerar também o ID imutável. Isso mantém a
-- proteção global em INSERT e ao restaurar tombstones por qualquer outro fluxo.
create or replace function public.prevent_zernio_instagram_identity_conflict()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  identity_value text;
  immutable_identity_value text;
  old_identity_value text;
  old_immutable_identity_value text;
begin
  if new.provider <> 'zernio' or new.deleted_at is not null then
    return new;
  end if;

  identity_value := lower(nullif(trim(regexp_replace(new.username, '^@', '')), ''));
  immutable_identity_value := public.zernio_instagram_immutable_identity(
    coalesce(new.zernio_account_metadata, '{}'::jsonb)
  );
  if identity_value is null then
    raise exception 'Identidade Instagram Zernio inválida.';
  end if;

  if tg_op = 'UPDATE' then
    old_identity_value := lower(nullif(trim(regexp_replace(old.username, '^@', '')), ''));
    old_immutable_identity_value := public.zernio_instagram_immutable_identity(
      coalesce(old.zernio_account_metadata, '{}'::jsonb)
    );
    if old.provider = 'zernio'
       and old.deleted_at is null
       and old_identity_value is not distinct from identity_value
       and old_immutable_identity_value is not distinct from immutable_identity_value then
      return new;
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('zernio-identity:' || identity_value, 0));
  if immutable_identity_value is not null then
    perform pg_advisory_xact_lock(hashtextextended(
      'zernio-immutable-identity:' || immutable_identity_value,
      0
    ));
  end if;

  if exists (
    select 1
    from public.instagram_profiles profile
    where profile.provider = 'zernio'
      and profile.deleted_at is null
      and profile.id is distinct from new.id
      and (
        lower(trim(regexp_replace(profile.username, '^@', ''))) = identity_value
        or (
          immutable_identity_value is not null
          and public.zernio_instagram_immutable_identity(
            coalesce(profile.zernio_account_metadata, '{}'::jsonb)
          ) = immutable_identity_value
        )
      )
  ) then
    raise exception using
      errcode = '23505',
      message = 'A identidade Instagram já está vinculada a outra conexão ou organização; resolva o conflito explicitamente.';
  end if;

  return new;
end;
$$;

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
  immutable_identity_value text;
  existing_immutable_identity_value text;
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
    desired_metadata := coalesce(input_row -> 'zernio_account_metadata', '{}'::jsonb);
    immutable_identity_value := public.zernio_instagram_immutable_identity(desired_metadata);

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
    if immutable_identity_value is not null then
      perform pg_advisory_xact_lock(hashtextextended(
        'zernio-immutable-identity:' || immutable_identity_value,
        0
      ));
    end if;

    existing_profile := null;
    select profile.* into existing_profile from public.instagram_profiles profile
    where profile.organization_id = p_organization_id
      and profile.provider = 'zernio'
      and profile.zernio_account_id = remote_account_id
    order by (case when profile.deleted_at is null then 0 else 1 end), profile.created_at, profile.id
    limit 1 for update;
    existing_found := found;

    if existing_found then
      existing_immutable_identity_value := public.zernio_instagram_immutable_identity(
        coalesce(existing_profile.zernio_account_metadata, '{}'::jsonb)
      );

      if existing_immutable_identity_value is not null
         and immutable_identity_value is not null
         and existing_immutable_identity_value <> immutable_identity_value then
        return query select existing_profile.id, 'conflict'::text,
          'O accountId Zernio aponta para outra identidade imutável; nenhuma atribuição foi alterada.'::text;
        continue;
      end if;

      if (
        existing_profile.zernio_connection_id <> p_zernio_connection_id
        or existing_profile.zernio_profile_id is distinct from desired_zernio_profile_id
      ) and not (
        existing_profile.deleted_at is not null
        and immutable_identity_value is not null
        and existing_immutable_identity_value = immutable_identity_value
      ) then
        return query select existing_profile.id, 'conflict'::text,
          'O accountId Zernio já possui vínculo canônico diferente; nenhuma atribuição foi alterada.'::text;
        continue;
      end if;
    end if;

    if not existing_found then
      -- Um perfil ativo sempre vence e bloqueia qualquer movimentação, inclusive
      -- quando o username mudou mas o ID imutável permaneceu igual.
      identity_profile := null;
      select profile.* into identity_profile from public.instagram_profiles profile
      where profile.provider = 'zernio'
        and profile.deleted_at is null
        and (
          lower(trim(regexp_replace(profile.username, '^@', ''))) = identity_value
          or (
            immutable_identity_value is not null
            and public.zernio_instagram_immutable_identity(
              coalesce(profile.zernio_account_metadata, '{}'::jsonb)
            ) = immutable_identity_value
          )
        )
      order by profile.created_at, profile.id limit 1 for update;
      if found then
        return query select identity_profile.id, 'conflict'::text,
          'A identidade Instagram já pertence a outro perfil ativo; nenhuma atribuição foi alterada.'::text;
        continue;
      end if;

      -- A única movimentação entre conexão/profile permitida é a reativação de
      -- um tombstone da mesma organização com o mesmo ID imutável comprovado.
      if immutable_identity_value is not null then
        existing_profile := null;
        select profile.* into existing_profile from public.instagram_profiles profile
        where profile.organization_id = p_organization_id
          and profile.provider = 'zernio'
          and profile.deleted_at is not null
          and public.zernio_instagram_immutable_identity(
            coalesce(profile.zernio_account_metadata, '{}'::jsonb)
          ) = immutable_identity_value
        order by
          case when lower(trim(regexp_replace(profile.username, '^@', ''))) = identity_value then 0 else 1 end,
          profile.created_at, profile.id
        limit 1 for update;
        existing_found := found;
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

      if not existing_found and immutable_identity_value is not null then
        identity_profile := null;
        select profile.* into identity_profile from public.instagram_profiles profile
        where profile.provider = 'zernio'
          and profile.organization_id <> p_organization_id
          and public.zernio_instagram_immutable_identity(
            coalesce(profile.zernio_account_metadata, '{}'::jsonb)
          ) = immutable_identity_value
        order by profile.created_at, profile.id limit 1 for update;
        if found then
          return query select identity_profile.id, 'conflict'::text,
            'A identidade imutável pertence ao histórico de outra organização; a reassociação foi bloqueada.'::text;
          continue;
        end if;
      end if;
    end if;

    if existing_found then
      identity_profile := null;
      select profile.* into identity_profile from public.instagram_profiles profile
      where profile.provider = 'zernio' and profile.deleted_at is null
        and profile.id <> existing_profile.id
        and (
          lower(trim(regexp_replace(profile.username, '^@', ''))) = identity_value
          or (
            immutable_identity_value is not null
            and public.zernio_instagram_immutable_identity(
              coalesce(profile.zernio_account_metadata, '{}'::jsonb)
            ) = immutable_identity_value
          )
        )
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

-- Depois que uma conta já foi observada no profile remoto, ele está ocupado
-- mesmo se a persistência local conflitar ou falhar. A marcação é idempotente.
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
  set status = 'connected', connected_at = coalesce(connected_at, timezone('utc', now())),
      updated_at = timezone('utc', now())
  where remote_profile.claimed_by_attempt_id = p_attempt_id
    and remote_profile.status = 'claimed'
  returning true into changed;
  if coalesce(changed, false) then return true; end if;
  return exists (
    select 1 from public.zernio_connection_remote_profiles remote_profile
    where remote_profile.claimed_by_attempt_id = p_attempt_id
      and remote_profile.status = 'connected'
  );
end;
$$;

-- Somente falha anterior à abertura do OAuth comprova que o profile está vazio.
-- Qualquer falha posterior fica fora do pool até limpeza ou reconciliação.
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
  set status = case
        when p_reason = 'oauth_start_failed' then 'available'
        else 'cleanup_pending'
      end,
      claimed_by_attempt_id = null,
      released_at = timezone('utc', now()),
      release_reason = left(coalesce(p_reason, 'released'), 200),
      updated_at = timezone('utc', now())
  where remote_profile.claimed_by_attempt_id = p_attempt_id
    and remote_profile.status = 'claimed'
  returning true into released;
  return coalesce(released, false);
end;
$$;

revoke all on function public.reconcile_zernio_connection_accounts(uuid, uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.mark_zernio_attempt_remote_profile_connected(uuid)
  from public, anon, authenticated;
revoke all on function public.release_zernio_attempt_remote_profile(uuid, text)
  from public, anon, authenticated;
grant execute on function public.reconcile_zernio_connection_accounts(uuid, uuid, jsonb)
  to service_role;
grant execute on function public.mark_zernio_attempt_remote_profile_connected(uuid)
  to service_role;
grant execute on function public.release_zernio_attempt_remote_profile(uuid, text)
  to service_role;

notify pgrst, 'reload schema';
