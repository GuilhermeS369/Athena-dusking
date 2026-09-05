-- A vaga que o perfil deixou ao trocar de app passa a aparecer em /meta.
--
-- `instagram_profile_count` conta perfis por `meta_app_id`, entao um perfil que
-- muda de app some do app antigo na hora e ele parece ganhar uma vaga. Do lado
-- da Meta a conexao continua la: a Meta nao sabe que o Athena passou a usar
-- outro app para aquela conta. E a mesma vaga fantasma que a migration 389
-- corrigiu para o perfil removido por checkpoint, agora pela porta da
-- transferencia.
--
-- `transferred_out_count` conta as saidas ainda nao confirmadas no Meta
-- Developers, e entra no calculo de vaga presa junto com
-- `pending_slot_release_count`. Sao dois numeros separados na tela de proposito
-- -- "saiu porque caiu" e "saiu porque foi movido" pedem acoes diferentes de
-- quem opera.
--
-- COLUNA NOVA VAI NO FIM. `create or replace view` so aceita acrescentar no
-- final; inserir no meio renomeia as seguintes e o Postgres recusa com 42P16.
-- Foi assim que a 396 falhou na primeira tentativa.
--
-- E NAO PRECISA DE GRANT POR COLUNA. O grant por coluna da migration 398 existe
-- porque `meta_apps_safe` e `security_invoker` e o leitor precisa de privilegio
-- nas colunas da TABELA `meta_apps`. Esta coluna nao vem de `meta_apps`: e uma
-- subconsulta em `meta_profile_app_transfers`, cujo SELECT foi concedido a
-- `authenticated` na migration 399, com RLS por organizacao.
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
  ), 0) as transferred_out_count
from public.meta_apps app;

grant select on public.meta_apps_safe to authenticated;

notify pgrst, 'reload schema';
