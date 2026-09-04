-- Athena Scheduler: a conexão pela Meta assume um perfil que já existe.
--
-- O PROBLEMA QUE ISTO RESOLVE. O callback da Meta gravava com
-- `on conflict (organization_id, instagram_user_id)`. Um perfil Zernio guarda
-- esse campo como o valor sintético `zernio:<accountId>`, que nunca é igual ao
-- id real devolvido pela Meta. Resultado: reconectar uma conta que já existia
-- criava uma LINHA NOVA. O perfil antigo continuava lá, morto, e o novo nascia
-- sem histórico — sem métricas, sem grupos, sem posts. Exatamente o que não
-- pode acontecer numa migração de 3.293 contas.
--
-- A CHAVE DA TRANSIÇÃO É O @. É o único identificador que as duas pontas
-- compartilham: a Zernio guardou o username, e a Meta devolve o username. A
-- comparação usa a MESMA normalização da guarda de identidade
-- (`lower(trim(regexp_replace(username, '^@', '')))`), para que os dois lados
-- concordem sobre o que é "a mesma conta".
--
-- POR QUE UMA FUNÇÃO, E NÃO CONSULTAS SOLTAS NA ROTA. Três razões:
--   1. Atomicidade: resolver quem é o alvo e gravar precisa ser um passo só.
--      No meio disso o perfil não pode ser tocado por outro aparelho.
--   2. Concorrência: dois celulares autorizando o mesmo @ ao mesmo tempo
--      criariam duas linhas. O lock consultivo por (organização, @) serializa.
--   3. O caso ambíguo tem de ser recusado, não adivinhado. Se um perfil casa
--      pelo id da Meta e OUTRO casa pelo @, existem duas contas concorrendo
--      pela mesma identidade e a decisão é humana.
--
-- O HISTÓRICO SOBREVIVE PORQUE O id DA LINHA NÃO MUDA. Métricas, membros de
-- grupo, itens de fila e posts apontam para instagram_profiles.id. Trocar o
-- provedor na própria linha preserva tudo; criar linha nova perderia tudo.

create or replace function public.connect_meta_instagram_profile(
  p_organization_id uuid,
  p_instagram_user_id text,
  p_username text,
  p_display_name text,
  p_profile_picture_url text,
  p_account_type text,
  p_encrypted_access_token text,
  p_token_expires_at timestamptz,
  p_meta_app_id uuid,
  p_created_by uuid
)
returns table (
  profile_id uuid,
  outcome text,
  previous_provider text,
  previous_username text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_username text;
  match_by_user_id public.instagram_profiles%rowtype;
  match_by_username public.instagram_profiles%rowtype;
  target public.instagram_profiles%rowtype;
  resolved_outcome text;
  carried_metadata jsonb;
begin
  normalized_username := lower(nullif(trim(regexp_replace(p_username, '^@', '')), ''));

  if normalized_username is null then
    raise exception 'Username vazio devolvido pela Meta.' using errcode = '22023';
  end if;

  -- Serializa conexões concorrentes da MESMA conta. Sem isto, dois aparelhos
  -- autorizando o mesmo @ ao mesmo tempo passariam os dois pela busca e
  -- criariam duas linhas antes de qualquer índice reclamar.
  perform pg_advisory_xact_lock(
    hashtextextended('meta_connect:' || p_organization_id::text || ':' || normalized_username, 0)
  );

  select * into match_by_user_id
  from public.instagram_profiles
  where organization_id = p_organization_id
    and instagram_user_id = p_instagram_user_id
    and deleted_at is null
  for update;

  select * into match_by_username
  from public.instagram_profiles
  where organization_id = p_organization_id
    and deleted_at is null
    and lower(trim(regexp_replace(username, '^@', ''))) = normalized_username
  for update;

  -- Duas linhas distintas reivindicando a mesma conta. Pode acontecer se uma
  -- reconexão anterior já criou a duplicata que esta função existe para
  -- evitar. Fundir as duas envolve escolher qual histórico fica, e isso não é
  -- decisão de código.
  if match_by_user_id.id is not null
     and match_by_username.id is not null
     and match_by_user_id.id is distinct from match_by_username.id then
    return query select
      null::uuid,
      'conflict'::text,
      match_by_username.provider::text,
      match_by_username.username;
    return;
  end if;

  target := coalesce(match_by_user_id, match_by_username);

  if target.id is null then
    insert into public.instagram_profiles (
      organization_id, instagram_user_id, username, display_name,
      profile_picture_url, account_type, provider, capabilities,
      encrypted_access_token, token_expires_at, token_refreshed_at,
      token_refresh_attempted_at, token_refresh_error, token_refresh_failure_count,
      meta_app_id, status, last_success_at, last_error_code, last_error_message,
      created_by
    ) values (
      p_organization_id, p_instagram_user_id, trim(p_username), p_display_name,
      p_profile_picture_url, p_account_type, 'meta_official',
      jsonb_build_object('instagram_business_basic', true, 'instagram_business_content_publish', true),
      p_encrypted_access_token, p_token_expires_at, timezone('utc', now()),
      null, null, 0,
      p_meta_app_id, 'online', timezone('utc', now()), null, null,
      p_created_by
    )
    returning id into target.id;

    return query select target.id, 'created'::text, null::text, null::text;
    return;
  end if;

  resolved_outcome := case when target.provider = 'meta_official' then 'updated' else 'takeover' end;

  -- Guarda a identidade antiga antes de apagá-la das colunas. A restrição
  -- instagram_profiles_provider_credentials_check exige zernio_account_id nulo
  -- em meta_official, então as colunas TÊM de ser limpas — sem este registro, a
  -- origem da conta desapareceria sem deixar rastro.
  carried_metadata := coalesce(target.zernio_account_metadata, '{}'::jsonb);
  if resolved_outcome = 'takeover' then
    carried_metadata := carried_metadata || jsonb_build_object(
      'migrated_to_meta_at', timezone('utc', now()),
      'previous_provider', target.provider::text,
      'previous_instagram_user_id', target.instagram_user_id,
      'previous_zernio_account_id', target.zernio_account_id,
      'previous_zernio_profile_id', target.zernio_profile_id,
      'previous_zernio_connection_id', target.zernio_connection_id
    );
  end if;

  update public.instagram_profiles set
    instagram_user_id = p_instagram_user_id,
    username = trim(p_username),
    display_name = coalesce(p_display_name, display_name),
    profile_picture_url = coalesce(p_profile_picture_url, profile_picture_url),
    account_type = coalesce(p_account_type, account_type),
    provider = 'meta_official',
    capabilities = jsonb_build_object(
      'instagram_business_basic', true,
      'instagram_business_content_publish', true
    ),
    encrypted_access_token = p_encrypted_access_token,
    token_expires_at = p_token_expires_at,
    token_refreshed_at = timezone('utc', now()),
    token_refresh_attempted_at = null,
    token_refresh_error = null,
    token_refresh_failure_count = 0,
    meta_app_id = p_meta_app_id,
    -- A conta acabou de provar que responde: o /me da Meta respondeu com este
    -- username. Voltar para online aqui é o que tira o perfil do estado de
    -- transição e o devolve para /postagem, dashboard e recuperação.
    status = 'online',
    last_success_at = timezone('utc', now()),
    last_failure_at = null,
    last_error_code = null,
    last_error_message = null,
    -- Solta o vínculo com a Zernio. Além de exigido pela restrição, é o que
    -- devolve a vaga na chave Zernio e tira o perfil das contagens dela.
    zernio_account_id = null,
    zernio_profile_id = null,
    zernio_connection_id = null,
    zernio_account_metadata = carried_metadata
  where id = target.id;

  return query select
    target.id,
    resolved_outcome,
    target.provider::text,
    target.username;
end;
$$;

revoke all on function public.connect_meta_instagram_profile(
  uuid, text, text, text, text, text, text, timestamptz, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.connect_meta_instagram_profile(
  uuid, text, text, text, text, text, text, timestamptz, uuid, uuid
) to service_role;

notify pgrst, 'reload schema';
