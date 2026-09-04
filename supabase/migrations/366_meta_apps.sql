-- Athena Scheduler: apps próprios da Meta (Instagram Login for Business).
--
-- Até aqui a organização inteira conectava perfis com UMA credencial global
-- vinda de INSTAGRAM_CLIENT_ID/INSTAGRAM_CLIENT_SECRET. Isso não escala: cada
-- app da Meta comporta um número limitado de contas, e não havia como saber
-- por qual credencial um perfil entrou. Esta migração cria o cadastro de apps
-- por organização e passa a registrar, em cada perfil, o app que o conectou.
--
-- Os perfis já conectados ficam com meta_app_id nulo de propósito: eles seguem
-- válidos (o token deles já está salvo) e aparecem na tela como conexões
-- legadas da chave global. Nada é migrado à força.

create table public.meta_apps (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  label text not null check (char_length(trim(label)) between 2 and 80),
  -- Identificador numérico do app no painel da Meta. Não é segredo: aparece na
  -- URL de autorização e por isso pode ser lido pelo papel authenticated.
  app_id text not null check (trim(app_id) ~ '^[0-9]{6,32}$'),
  encrypted_app_secret text not null check (char_length(trim(encrypted_app_secret)) between 16 and 2000),
  instagram_slot_limit integer not null default 100 check (instagram_slot_limit between 1 and 1000),
  active boolean not null default true,
  last_connected_at timestamptz,
  created_by uuid not null references auth.users (id) on delete restrict,
  deleted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

-- O nome é a chave que o operador digita no Bulk Meta e no campo de colar.
-- Ele precisa ser único enquanto ativo, senão "duskingapp;GG Lexy" fica ambíguo.
create unique index meta_apps_org_label_active_idx
  on public.meta_apps (organization_id, lower(label))
  where deleted_at is null;

-- O mesmo app da Meta cadastrado duas vezes dividiria a contagem de vagas em
-- duas linhas e estouraria o limite real sem ninguém perceber.
create unique index meta_apps_org_app_id_active_idx
  on public.meta_apps (organization_id, app_id)
  where deleted_at is null;

create index meta_apps_org_active_idx
  on public.meta_apps (organization_id, created_at desc)
  where deleted_at is null;

create trigger meta_apps_set_updated_at
before update on public.meta_apps
for each row execute function public.set_updated_at();

alter table public.meta_apps enable row level security;

create policy meta_apps_select_operator
on public.meta_apps for select
to authenticated
using (public.has_organization_role(organization_id, array['admin', 'operator']::public.organization_role[]));

create policy meta_apps_insert_admin
on public.meta_apps for insert
to authenticated
with check (
  created_by = (select auth.uid())
  and public.has_organization_role(organization_id, array['admin']::public.organization_role[])
);

create policy meta_apps_update_admin
on public.meta_apps for update
to authenticated
using (public.has_organization_role(organization_id, array['admin']::public.organization_role[]))
with check (public.has_organization_role(organization_id, array['admin']::public.organization_role[]));

create policy meta_apps_delete_admin
on public.meta_apps for delete
to authenticated
using (public.has_organization_role(organization_id, array['admin']::public.organization_role[]));

alter table public.instagram_profiles
  add column meta_app_id uuid references public.meta_apps (id) on delete set null;

-- A contagem de vagas do app é exatamente esta consulta, então ela precisa de
-- índice: a tela de perfis a executa uma vez por app cadastrado.
create index instagram_profiles_org_meta_app_idx
  on public.instagram_profiles (organization_id, meta_app_id)
  where provider = 'meta_official' and deleted_at is null;

create view public.meta_apps_safe with (security_invoker = true) as
select
  app.id,
  app.organization_id,
  app.label,
  app.app_id,
  app.instagram_slot_limit,
  app.active,
  app.last_connected_at,
  app.created_by,
  app.deleted_at,
  app.created_at,
  app.updated_at,
  coalesce((
    select count(*)::integer
    from public.instagram_profiles profile
    where profile.organization_id = app.organization_id
      and profile.provider = 'meta_official'
      and profile.meta_app_id = app.id
      and profile.deleted_at is null
  ), 0) as instagram_profile_count
from public.meta_apps app;

-- O segredo do app nunca sai por PostgREST. A view é security_invoker, então
-- quem a lê precisa de select nas colunas listadas acima — e só nelas. O
-- privilégio de tabela inteira é retirado justamente para que um `select *`
-- direto em meta_apps não devolva encrypted_app_secret a ninguém logado.
revoke select on public.meta_apps from authenticated;
grant select (
  id, organization_id, label, app_id, instagram_slot_limit, active,
  last_connected_at, created_by, deleted_at, created_at, updated_at
) on public.meta_apps to authenticated;
grant insert, update, delete on public.meta_apps to authenticated;
grant select on public.meta_apps_safe to authenticated;
grant all on public.meta_apps to service_role;

-- instagram_profiles é lida por coluna pelo papel authenticated (o token fica
-- de fora). A coluna nova precisa entrar nessa lista, senão a view abaixo — que
-- é security_invoker — passa a falhar para quem não é service_role.
grant select (meta_app_id) on table public.instagram_profiles to authenticated;

-- A projeção segura ganha o app de origem para que a tela consiga separar as
-- conexões novas das que vieram da credencial global. Nada mais muda: as
-- colunas anteriores são repetidas exatamente como estavam.
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
  created_by,
  deleted_at,
  created_at,
  updated_at
from public.instagram_profiles;

grant select on public.instagram_profiles_safe to authenticated;

notify pgrst, 'reload schema';
