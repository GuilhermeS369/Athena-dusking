-- Identidade do perfil (username, nome, foto) passa a ser relida da Meta.
--
-- O QUE ACONTECIA. `instagram_profiles.username`/`display_name`/`profile_picture_url`
-- eram gravados uma unica vez, na conexao (`connect_meta_instagram_profile`,
-- migration 399), e nunca mais relidos. Em 15/09/2026 uma auditoria com uma
-- chamada `GET /me` por perfil online achou 453 de 2.243 perfis com username E
-- nome diferentes do gravado, e mais 145 so com o nome trocado. A conta segue
-- viva na Meta (token, publicacoes e metricas normais), mas
-- `instagram.com/<username-antigo>` da "pagina nao disponivel" e o perfil
-- parece caido no painel. Nao e queda: e renomeacao feita por quem tem o login
-- da conta, concentrada em lotes de operadores.
--
-- O QUE ENTRA AQUI.
-- 1. `refresh_instagram_profile_identity`: recebe o que a Meta devolveu em `me`
--    e so escreve quando algo mudou de verdade. Nao toca em status, token nem
--    `last_*` -- 190 continua sendo assunto do limpador da fila (secao 5 do
--    mestre) e do worker de renovacao, por decisao do dono.
-- 2. `instagram_profile_identity_changes`: trilha de cada troca, para responder
--    "quem era esse perfil antes" e medir em que lote a renomeacao acontece.
--    Sem FK para o perfil: a linha sobrevive a remocao dele.
--
-- QUEM CHAMA. A coleta de metricas (`persistMetaAnalyticsCollections`), que ja
-- pede `me` a cada rodada e antes descartava o username; o script de passada
-- completa `scripts/workers/meta-identity-refresh-worker.ts`; e o botao
-- Sincronizar do perfil. Todos com `service_role`.
--
-- POR QUE "SO ESCREVE QUANDO MUDOU". A coleta passa por ~2.200 perfis a cada
-- rodada. Um `update` incondicional dispararia `set_updated_at` e reescreveria
-- 2.200 linhas a cada 5 minutos por nada. A comparacao ignora `@` inicial,
-- espacos e caixa no username; a foto compara pela chave do arquivo (a Meta
-- troca host e assinatura da URL a cada chamada, o arquivo e o mesmo).

create table if not exists public.instagram_profile_identity_changes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  profile_id uuid not null,
  instagram_user_id text,
  previous_username text,
  new_username text,
  previous_display_name text,
  new_display_name text,
  picture_changed boolean not null default false,
  source text not null check (source in ('analytics', 'worker', 'health')),
  changed_at timestamptz not null default timezone('utc', now())
);

create index if not exists instagram_profile_identity_changes_org_changed_idx
  on public.instagram_profile_identity_changes(organization_id, changed_at desc);
create index if not exists instagram_profile_identity_changes_profile_idx
  on public.instagram_profile_identity_changes(profile_id, changed_at desc);

alter table public.instagram_profile_identity_changes enable row level security;

drop policy if exists instagram_profile_identity_changes_select_member on public.instagram_profile_identity_changes;
create policy instagram_profile_identity_changes_select_member
  on public.instagram_profile_identity_changes for select to authenticated
  using (public.is_organization_member(organization_id));

revoke all on public.instagram_profile_identity_changes from public, anon, authenticated;
grant select on public.instagram_profile_identity_changes to authenticated;
grant all on public.instagram_profile_identity_changes to service_role;

-- Chave estavel da foto: o nome do arquivo no CDN da Meta. Duas URLs do mesmo
-- arquivo diferem em host, `_nc_ohc`, `oh`, `oe`... e a comparacao crua
-- acusaria troca a cada rodada.
create or replace function public.instagram_picture_key(p_url text)
returns text
language sql
immutable
as $$
  select nullif(substring(coalesce(p_url, '') from '/([^/?]+\.(?:jpg|jpeg|png|webp))(?:\?|$)'), '');
$$;

create or replace function public.refresh_instagram_profile_identity(
  p_profile_id uuid,
  p_username text,
  p_display_name text,
  p_profile_picture_url text,
  p_source text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  profile_row public.instagram_profiles%rowtype;
  new_username text := nullif(trim(regexp_replace(coalesce(p_username, ''), '^@', '')), '');
  new_display_name text := nullif(trim(coalesce(p_display_name, '')), '');
  username_changed boolean;
  display_name_changed boolean;
  picture_changed boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;
  if p_source not in ('analytics', 'worker', 'health') then
    raise exception using errcode = '22023', message = 'Origem desconhecida.';
  end if;
  -- Sem username a Meta nao respondeu a conta; nao ha o que comparar.
  if new_username is null then
    return 'skipped';
  end if;

  select * into profile_row
  from public.instagram_profiles
  where id = p_profile_id
    and deleted_at is null
    and provider = 'meta_official'
  for update;

  if not found then
    return 'skipped';
  end if;

  username_changed := lower(new_username)
    is distinct from lower(trim(regexp_replace(coalesce(profile_row.username, ''), '^@', '')));
  -- Nome nulo vindo da Meta nao apaga o que temos (mesma regra da 399).
  display_name_changed := new_display_name is not null
    and new_display_name is distinct from nullif(trim(coalesce(profile_row.display_name, '')), '');
  picture_changed := p_profile_picture_url is not null
    and public.instagram_picture_key(p_profile_picture_url)
      is distinct from public.instagram_picture_key(profile_row.profile_picture_url);

  if not username_changed and not display_name_changed and not picture_changed then
    return 'unchanged';
  end if;

  update public.instagram_profiles
  set username = case when username_changed then new_username else username end,
      display_name = coalesce(new_display_name, display_name),
      profile_picture_url = case when picture_changed then p_profile_picture_url else profile_picture_url end
  where id = profile_row.id;

  insert into public.instagram_profile_identity_changes (
    organization_id, profile_id, instagram_user_id,
    previous_username, new_username, previous_display_name, new_display_name,
    picture_changed, source
  ) values (
    profile_row.organization_id, profile_row.id, profile_row.instagram_user_id,
    case when username_changed then profile_row.username else null end,
    case when username_changed then new_username else null end,
    case when display_name_changed then profile_row.display_name else null end,
    case when display_name_changed then new_display_name else null end,
    picture_changed, p_source
  );

  return 'updated';
end;
$$;

revoke all on function public.refresh_instagram_profile_identity(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.refresh_instagram_profile_identity(uuid, text, text, text, text) to service_role;
revoke all on function public.instagram_picture_key(text) from public, anon;
grant execute on function public.instagram_picture_key(text) to authenticated, service_role;
