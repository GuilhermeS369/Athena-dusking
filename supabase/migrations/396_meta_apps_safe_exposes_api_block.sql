-- A tela `/meta` passa a enxergar o bloqueio de API do app.
--
-- Sem isto o operador nao teria como saber que a Meta fechou um app: em 05/09
-- os 4 apps bloqueados publicavam zero havia horas e a unica pista estava no
-- `last_error_message` de itens soltos na fila. O desbloqueio depende de
-- alguem ir ao Meta Developers destravar, entao a informacao TEM que aparecer
-- na tela -- foi a primeira coisa que o operador pediu ao decidir o fluxo.
--
-- `api_block_error_message` vai junto de proposito: a mensagem da Meta e a
-- unica descricao do motivo que existe, e obrigar o operador a caçá-la na fila
-- e o mesmo que nao mostrar.
--
-- Nada aqui expoe segredo: `encrypted_app_secret` continua fora da view, como
-- desde a migration 366.
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
  -- As colunas novas vao no FIM, e nao junto das outras do app, porque
  -- `create or replace view` so aceita acrescentar coluna no final: inserir no
  -- meio renomeia as seguintes e o Postgres recusa com 42P16.
  app.api_blocked_at,
  app.api_block_until,
  app.api_block_error_message,
  app.api_block_window_count,
  app.api_block_ignored_count,
  app.api_last_unblocked_at
from public.meta_apps app;

grant select on public.meta_apps_safe to authenticated;

notify pgrst, 'reload schema';
