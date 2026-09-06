-- A tela precisa saber se e "aguarde" ou "religue".
--
-- `api_block_kind` distingue o app que a Meta pode reabrir (blocked, e a janela
-- testa sozinha) do app desativado (deactivated, que nao volta e cujas contas
-- precisam ser religadas em outro app). Sem essa coluna a tela daria o mesmo
-- aviso para os dois casos, e o operador ficaria esperando por algo que nao vem.
--
-- Coluna nova vai no FIM: `create or replace view` so aceita acrescentar no
-- final. E ela vem de `meta_apps`, entao PRECISA de grant por coluna -- a view e
-- security_invoker e `meta_apps` so tem grant por coluna para `authenticated`.
-- Foi exatamente isso que derrubou /meta quando as colunas de bloqueio
-- entraram, e a migration 398 existe por causa disso.
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
  app.api_block_kind
from public.meta_apps app;

grant select on public.meta_apps_safe to authenticated;
grant select (api_block_kind) on table public.meta_apps to authenticated;

notify pgrst, 'reload schema';
