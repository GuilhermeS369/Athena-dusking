-- Perfil que perdeu o app deixa rastro de qual app era, e sai de "online".
--
-- O QUE ACONTECEU EM 06/09/2026. O operador apagou sete apps em /meta. A rota
-- de exclusão solta os perfis (`meta_app_id = null`) de propósito, para não
-- apontarem para um app que não existe mais -- e até aqui está certo. O que
-- faltava era registrar POR QUE ficaram soltos.
--
-- Sem esse registro, a tela não distingue dois casos que pedem coisas opostas:
--
--   * perfil que NUNCA teve app -- entrou pela credencial global, antes de o
--     cadastro de apps existir. Esse pode ser adotado pelo app do servidor.
--   * perfil que PERDEU o app -- o token dele foi emitido por um app que saiu
--     do ar, então ele não publica mais e precisa ser religado em outro.
--
-- Os dois caíam no mesmo cartão, que oferecia adotar pelo app do servidor. Para
-- os 22 do segundo caso isso seria errado duas vezes: os amarraria a um app que
-- nunca emitiu os tokens deles, e esconderia que precisam ser religados. Eu só
-- consegui separar os grupos por perícia -- comparando o `updated_at` do perfil
-- com o instante de exclusão de cada app, que bate a menos de 300 ms porque
-- cada exclusão soltou seus perfis num único UPDATE. Isso funciona uma vez; não
-- é jeito de a tela saber.
--
-- E O STATUS. Esses perfis continuavam `online` porque nada os marcou: o
-- tratamento de app bloqueado marca a PUBLICAÇÃO como ignorada, não o PERFIL
-- como offline. Resultado: 22 perfis exibidos como saudáveis, com token que
-- responde `200 / API access deactivated` e zero publicações no dia. Um perfil
-- que não publica não pode aparecer verde.
alter table public.instagram_profiles
  add column if not exists orphaned_from_meta_app_id uuid
    references public.meta_apps(id) on delete set null,
  add column if not exists orphaned_from_meta_app_label text,
  add column if not exists orphaned_at timestamptz;

comment on column public.instagram_profiles.orphaned_from_meta_app_label is
  'Rótulo do app da Meta que segurava este perfil quando ele foi descadastrado. Guardado como texto porque o app pode ser removido depois.';

create index if not exists instagram_profiles_orphaned_idx
  on public.instagram_profiles (organization_id, orphaned_at desc)
  where orphaned_at is not null and deleted_at is null;

-- Solta os perfis de um app que está saindo do cadastro, deixando rastro.
--
-- Vive no banco, e não na rota, porque são três escritas que precisam valer
-- juntas: o vínculo cai, a origem é guardada e o status deixa de mentir. Feito
-- na rota, uma falha no meio deixaria perfil solto sem origem -- exatamente o
-- estado que esta migration existe para não produzir de novo.
create or replace function public.release_profiles_from_meta_app(
  p_organization_id uuid,
  p_app_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  app_row public.meta_apps%rowtype;
  released_count integer := 0;
begin
  if auth.role() <> 'service_role'
    and not public.has_organization_role(
      p_organization_id,
      array['admin']::public.organization_role[]
    ) then
    raise exception using errcode = '42501', message = 'Somente administradores podem remover apps da Meta.';
  end if;

  select * into app_row from public.meta_apps app
  where app.id = p_app_id and app.organization_id = p_organization_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'App Meta não encontrado.';
  end if;

  with soltos as (
    update public.instagram_profiles profile set
      meta_app_id = null,
      orphaned_from_meta_app_id = p_app_id,
      orphaned_from_meta_app_label = app_row.label,
      orphaned_at = timezone('utc', now()),
      -- O token foi emitido pelo app que está saindo. Enquanto o perfil não for
      -- religado, ele não publica -- e a tela precisa dizer isso.
      status = case when profile.deleted_at is null then 'reauthorization_required' else profile.status end,
      last_error_code = case when profile.deleted_at is null then 'meta_app_unregistered' else profile.last_error_code end,
      last_error_message = case
        when profile.deleted_at is null
          then 'O app “' || app_row.label || '” saiu do cadastro; religue esta conta em outro app.'
        else profile.last_error_message
      end
    where profile.organization_id = p_organization_id
      and profile.meta_app_id = p_app_id
    returning profile.id, profile.deleted_at
  )
  select count(*) filter (where soltos.deleted_at is null)::integer into released_count from soltos;

  return jsonb_build_object('released', released_count, 'metaAppLabel', app_row.label);
end;
$$;

revoke all on function public.release_profiles_from_meta_app(uuid, uuid) from public, anon;
grant execute on function public.release_profiles_from_meta_app(uuid, uuid) to authenticated, service_role;

-- Religar limpa o rastro: o perfil voltou a ter app, então não é mais órfão.
create or replace function public.clear_profile_orphan_origin(p_profile_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.instagram_profiles set
    orphaned_from_meta_app_id = null,
    orphaned_from_meta_app_label = null,
    orphaned_at = null
  where id = p_profile_id and orphaned_at is not null;
$$;

revoke all on function public.clear_profile_orphan_origin(uuid) from public, anon, authenticated;
grant execute on function public.clear_profile_orphan_origin(uuid) to service_role;

create or replace view public.instagram_profiles_safe
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
  updated_at,
  orphaned_from_meta_app_id,
  orphaned_from_meta_app_label,
  orphaned_at
from public.instagram_profiles;

grant select on public.instagram_profiles_safe to authenticated;
-- A view é security_invoker: quem lê precisa de privilégio nas colunas da
-- TABELA. `instagram_profiles` tem grant por coluna, e ele não cresce sozinho
-- quando a tabela cresce -- foi assim que /meta caiu em 05/09 (migration 398).
grant select (orphaned_from_meta_app_id, orphaned_from_meta_app_label, orphaned_at)
  on table public.instagram_profiles to authenticated;

notify pgrst, 'reload schema';
