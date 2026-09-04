-- Corrige a resolução do alvo em connect_meta_instagram_profile (migration 373)
-- antes de a migração em massa começar.
--
-- BUG 1, e é o que anularia a função inteira. A resolução era
-- `target := coalesce(match_by_user_id, match_by_username)`. Quando um
-- `select ... into` de uma variável %rowtype não encontra linha, o PL/pgSQL
-- deixa a variável com TODOS os campos nulos — o que não é a mesma coisa que a
-- variável ser nula. Um composto de campos nulos pode ser tratado como
-- não-nulo, e nesse caso o coalesce devolve a linha VAZIA da primeira busca e
-- ignora a segunda. O efeito seria: nenhuma conta seria assumida pelo @, e cada
-- reconexão criaria um perfil novo e zerado — precisamente o problema que a 373
-- foi escrita para eliminar, e em todas as 1.551 contas.
--
-- Não vale depender da interpretação: a escolha do alvo passa a ser explícita,
-- testando o `id` de cada candidato, que é inequívoco em qualquer versão.
--
-- BUG 2. `select ... into` com mais de uma linha não falha: ele pega uma
-- qualquer, em ordem indefinida. Se dois perfis dividirem o mesmo @, a conta
-- seria entregue a um deles por sorteio. Medido em 04/09/2026: zero @ repetidos
-- dentro de uma organização. Mesmo assim, sortear a identidade de uma conta é
-- pior do que recusar — agora conta os candidatos e devolve 'conflict', que é o
-- mesmo caminho já usado quando id e @ apontam para linhas diferentes.

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
  username_match_count integer;
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

  select count(*) into username_match_count
  from public.instagram_profiles
  where organization_id = p_organization_id
    and deleted_at is null
    and lower(trim(regexp_replace(username, '^@', ''))) = normalized_username;

  -- Dois perfis com o mesmo @: entregar a conta a um deles seria sorteio.
  if username_match_count > 1 then
    return query select null::uuid, 'conflict'::text, null::text, p_username;
    return;
  end if;

  if username_match_count = 1 then
    select * into match_by_username
    from public.instagram_profiles
    where organization_id = p_organization_id
      and deleted_at is null
      and lower(trim(regexp_replace(username, '^@', ''))) = normalized_username
    for update;
  end if;

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

  -- Escolha explícita pelo id de cada candidato. Ver BUG 1 no cabeçalho: o
  -- coalesce sobre %rowtype não é confiável para dizer "não achei nada".
  if match_by_user_id.id is not null then
    target := match_by_user_id;
  elsif match_by_username.id is not null then
    target := match_by_username;
  end if;

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

notify pgrst, 'reload schema';
