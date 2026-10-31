-- Rota alternativa de conexao: Unified Login (30/10/2026).
--
-- A Meta nao deixa mais app novo configurar o Instagram Login, e o dono pediu a
-- rota nova ao lado da antiga, para testar com calma sem mexer no que funciona.
-- O modo mora no APP, e nao no perfil: um perfil publica pelo modo do app que
-- detem a conta, entao religar a conta por um app antigo devolve o modo antigo
-- na mesma escrita de `connect_meta_instagram_profile`, sem coluna para esquecer.
--
-- Todo app existente nasce `instagram_login` pelo default. O modo nao muda depois
-- do cadastro: o token de um modo nao vale no outro, e os publicadores guardam o
-- modo de cada app em memoria.
alter table public.meta_apps
  add column auth_mode text not null default 'instagram_login',
  add column unified_config_id text;

alter table public.meta_apps
  add constraint meta_apps_auth_mode_check
    check (auth_mode in ('instagram_login', 'unified_login')),
  add constraint meta_apps_unified_config_check
    check (auth_mode <> 'unified_login' or unified_config_id is not null);

-- Coluna nova vai no FIM da view, e precisa de grant por coluna (ver 404). So o
-- modo vai para a tela: o `config_id` nao e segredo, mas nenhuma tela o usa.
create or replace view public.meta_apps_safe with (security_invoker = true) as
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
  ), 0) as instagram_profile_count,
  coalesce((
    select count(*)::integer
    from public.meta_profile_disconnection_incidents incident
    where incident.organization_id = app.organization_id
      and incident.meta_app_id = app.id
      and incident.slot_released_at is null
  ), 0) as pending_slot_release_count,
  app.api_blocked_at,
  app.api_block_until,
  app.api_block_error_message,
  app.api_block_window_count,
  app.api_block_ignored_count,
  app.api_last_unblocked_at,
  coalesce((
    select count(*)::integer
    from public.meta_profile_app_transfers transfer
    where transfer.organization_id = app.organization_id
      and transfer.from_app_id = app.id
      and transfer.slot_released_at is null
  ), 0) as transferred_out_count,
  app.api_block_kind,
  app.auth_mode
from public.meta_apps app;

grant select on public.meta_apps_safe to authenticated;
grant select (auth_mode) on table public.meta_apps to authenticated;

notify pgrst, 'reload schema';
