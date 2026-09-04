-- Athena Scheduler: estado da renovação do token de longa duração da Meta.
--
-- O token de longa duração vale 60 dias e pode ser estendido por mais 60 com
-- `GET /refresh_access_token` (grant_type=ig_refresh_token), servidor a
-- servidor, sem o usuário ver nada — desde que o token tenha ao menos 24 h de
-- idade e a renovação aconteça DENTRO da janela. Passados os 60 dias sem
-- renovar, o refresh também deixa de funcionar: só um OAuth novo, perfil por
-- perfil.
--
-- Por que estas colunas, e não só token_expires_at (que já existe): a data de
-- expiração não distingue "renovação saudável" de "renovação quebrada há três
-- semanas". As duas mostram um número grande de dias até o dia em que não
-- mostram mais. token_refreshed_at é o que deixa a quebra visível enquanto
-- ainda há tempo de consertar.
--
-- O token continua morando em instagram_profiles.encrypted_access_token. Ele é
-- 1:1 com o perfil e a renovação é por token de usuário, não por app — uma
-- tabela separada só acrescentaria um join e uma chance de divergência.

alter table public.instagram_profiles
  -- Última renovação bem-sucedida. A conexão inicial também preenche este
  -- campo: o token nasce novo, e a idade dele é sempre now() - este valor.
  add column token_refreshed_at timestamptz,
  -- Última tentativa, tenha ela dado certo ou errado. Separado do anterior
  -- porque "tentou e falhou" e "nem tentou" são problemas diferentes: o
  -- primeiro é um erro da Meta, o segundo é o worker parado.
  add column token_refresh_attempted_at timestamptz,
  add column token_refresh_error text,
  -- Falhas consecutivas. Zera no primeiro sucesso. É o que separa um 500
  -- passageiro de uma renovação que parou de funcionar.
  add column token_refresh_failure_count integer not null default 0
    check (token_refresh_failure_count >= 0);

-- Retrato inicial dos perfis que já existem. token_expires_at foi gravado como
-- emissão + 60 dias no callback, então subtrair 60 dias devolve o instante da
-- emissão. Onde ele é nulo (conexão antiga que não recebeu expires_in), a
-- criação do perfil é a melhor aproximação disponível — e erra para o lado
-- seguro, porque envelhece o token e faz o worker renová-lo antes.
update public.instagram_profiles
set token_refreshed_at = coalesce(token_expires_at - interval '60 days', created_at)
where provider = 'meta_official'
  and deleted_at is null
  and token_refreshed_at is null;

-- O worker de renovação varre por idade do token dentro da organização. Sem
-- expressão no índice de propósito: token_refreshed_at é preenchido tanto na
-- conexão quanto na renovação, então a idade sai direto da coluna.
create index instagram_profiles_meta_token_renewal_idx
  on public.instagram_profiles (organization_id, token_refreshed_at)
  where provider = 'meta_official' and deleted_at is null;

grant select (
  token_refreshed_at, token_refresh_attempted_at, token_refresh_error, token_refresh_failure_count
) on table public.instagram_profiles to authenticated;

-- A projeção segura ganha o estado da renovação para que /perfis e a tela de
-- apps mostrem "renovado há N dias" em vez de só "expira em N dias". As colunas
-- anteriores são repetidas exatamente como estavam.
drop view if exists public.instagram_profiles_safe;

create view public.instagram_profiles_safe
with (security_invoker = true)
as
select
  id,
  organization_id,
  instagram_user_id,
  username,
  display_name,
  profile_picture_url,
  account_type,
  capabilities,
  token_expires_at,
  status,
  last_checked_at,
  last_success_at,
  last_failure_at,
  last_error_code,
  last_error_message,
  provider,
  zernio_profile_id,
  zernio_account_id,
  zernio_connection_id,
  zernio_account_metadata,
  meta_app_id,
  token_refreshed_at,
  token_refresh_attempted_at,
  token_refresh_error,
  token_refresh_failure_count,
  created_by,
  deleted_at,
  created_at,
  updated_at
from public.instagram_profiles;

grant select on public.instagram_profiles_safe to authenticated;

notify pgrst, 'reload schema';
