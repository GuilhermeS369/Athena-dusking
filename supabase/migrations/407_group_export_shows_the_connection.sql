-- A coluna "Zernio" da planilha vira "Conexao", e passa a dizer de onde o perfil
-- publica: o app da Meta ou a conta Zernio.
--
-- O QUE ESTAVA ERRADO. O ramo 'current' so olhava `zernio_connections`, entao
-- todo perfil que publica pela API oficial saia com a celula vazia -- 1.440 dos
-- 2.603 perfis vivos hoje, "Nao informado" um atras do outro. Pior: a linha de
-- QUEDA ja mostrava o app certo desde a migration 377, entao a mesma planilha
-- dizia o nome do app so depois que o perfil caiu.
--
-- E o nome da coluna mentia junto. A 377 pos o rotulo do app da Meta dentro de
-- `zernio_connection_label` e registrou que renomear "exigiria mexer no gerador
-- do XLSX e nas duas telas que leem a view, sem ganho para quem olha a
-- planilha". O ganho agora existe -- o cabecalho muda para quem le -- e o
-- gerador vai ser tocado de qualquer jeito.
--
-- POR QUE `drop view` E NAO `create or replace`. `create or replace view` exige
-- os mesmos nomes de coluna, e renomear e justamente o objetivo. Sem `cascade`:
-- se algum objeto passar a depender desta view, o push falha alto em vez de
-- derrubar o dependente em silencio.
--
-- POR QUE UM `case` POR PROVEDOR E NAO UM `coalesce` DOS DOIS ROTULOS. Hoje
-- nenhum perfil `meta_official` carrega `zernio_connection_id` (medido em
-- producao: 0 de 1.440), entao os dois dariam o mesmo resultado. Mas no dia em
-- que a transicao de provedor deixar o vinculo antigo para tras, o coalesce
-- mostraria a conta Zernio velha de um perfil que ja publica pela Meta -- e a
-- planilha e usada como fonte de verdade.
--
-- QUEM E `viewer` CONTINUA VENDO "Nao informado", e isso nao e regressao:
-- `meta_apps` e `zernio_connections` tem a mesma politica de select
-- (admin/operator), e a view e security_invoker, entao os dois joins somem do
-- mesmo jeito para quem nao tem o papel. O grant POR COLUNA de `meta_apps`
-- (migrations 366 e 398) ja cobre `id`, `organization_id` e `label` -- as tres
-- que este join toca. Ler com `service_role` nao provaria nada disso, pela
-- razao que a 398 escreveu por extenso.
--
-- A ORDEM DE COLUNAS E OS TIPOS NAO MUDAM; muda um nome. Os dois consumidores
-- (`app/api/groups/export-all` e `app/api/groups/[groupId]/export`) selecionam
-- coluna por coluna e sobem no mesmo deploy desta migration.

drop view if exists public.group_profile_export_rows;

create view public.group_profile_export_rows
with (security_invoker = true)
as
select
  group_row.organization_id,
  group_row.id as group_id,
  group_row.name as group_name,
  group_row.consumption_mode::text as group_consumption_mode,
  'current'::text as row_kind,
  profile.username,
  case profile.provider::text
    when 'zernio' then connection.label
    when 'meta_official' then meta_app.label
  end as connection_label,
  profile.created_at as profile_added_at,
  profile.status::text as profile_status,
  null::timestamptz as fallen_at,
  null::text as fall_reason,
  profile.id as profile_id,
  analytics.views as total_views,
  analytics.current_synced_at as analytics_synced_at
from public.profile_group_members member
join public.profile_groups group_row
  on group_row.id = member.group_id
 and group_row.organization_id = member.organization_id
join public.instagram_profiles profile
  on profile.id = member.profile_id
 and profile.organization_id = member.organization_id
left join public.zernio_connections connection
  on connection.id = profile.zernio_connection_id
 and connection.organization_id = profile.organization_id
left join public.meta_apps meta_app
  on meta_app.id = profile.meta_app_id
 and meta_app.organization_id = profile.organization_id
left join public.profile_analytics_current analytics
  on analytics.organization_id = profile.organization_id
 and analytics.profile_id = profile.id
 and analytics.deleted_at is null
where group_row.deleted_at is null
  and profile.deleted_at is null

union all

select
  group_row.organization_id,
  group_row.id as group_id,
  group_row.name as group_name,
  group_row.consumption_mode::text as group_consumption_mode,
  'fallen'::text as row_kind,
  incident.username_snapshot as username,
  incident.connection_label_snapshot as connection_label,
  profile.created_at as profile_added_at,
  'fallen'::text as profile_status,
  event.counted_at as fallen_at,
  concat_ws(
    ' — ',
    case incident.signal
      when 'account_disconnected' then 'Conta desconectada'
      when 'auth_expired' then 'Autorização expirada'
      else incident.signal
    end,
    nullif(trim(incident.error_code), ''),
    nullif(trim(incident.error_message), '')
  ) as fall_reason,
  profile.id as profile_id,
  coalesce(incident.analytics_views_snapshot, analytics.views) as total_views,
  coalesce(incident.analytics_synced_at_snapshot, analytics.current_synced_at) as analytics_synced_at
from public.zernio_group_profile_removal_events event
join public.profile_groups group_row
  on group_row.id = event.group_id
 and group_row.organization_id = event.organization_id
join public.zernio_profile_disconnection_incidents incident
  on incident.id = event.incident_id
 and incident.organization_id = event.organization_id
join public.instagram_profiles profile
  on profile.id = event.profile_id
 and profile.organization_id = event.organization_id
left join public.profile_analytics_current analytics
  on analytics.organization_id = profile.organization_id
 and analytics.profile_id = profile.id
 and analytics.deleted_at is null
where group_row.deleted_at is null
  and event.counted_at is not null

union all

-- Terceiro ramo: perfis removidos pela META. Espelha o ramo da Zernio acima e
-- existe pelo mesmo motivo -- a linha de `profile_group_members` e apagada de
-- verdade, entao sem o par incidente + evento o perfil sumiria da planilha em
-- silencio, sem aparecer como caido.
select
  group_row.organization_id,
  group_row.id as group_id,
  group_row.name as group_name,
  group_row.consumption_mode::text as group_consumption_mode,
  'fallen'::text as row_kind,
  incident.username_snapshot as username,
  incident.meta_app_label_snapshot as connection_label,
  profile.created_at as profile_added_at,
  'fallen'::text as profile_status,
  event.counted_at as fallen_at,
  concat_ws(
    ' — ',
    'Verificação exigida pela Meta',
    nullif(trim(incident.error_code), ''),
    nullif(trim(incident.error_message), '')
  ) as fall_reason,
  profile.id as profile_id,
  coalesce(incident.analytics_views_snapshot, analytics.views) as total_views,
  coalesce(incident.analytics_synced_at_snapshot, analytics.current_synced_at) as analytics_synced_at
from public.meta_group_profile_removal_events event
join public.profile_groups group_row
  on group_row.id = event.group_id
 and group_row.organization_id = event.organization_id
join public.meta_profile_disconnection_incidents incident
  on incident.id = event.incident_id
 and incident.organization_id = event.organization_id
join public.instagram_profiles profile
  on profile.id = event.profile_id
 and profile.organization_id = event.organization_id
left join public.profile_analytics_current analytics
  on analytics.organization_id = profile.organization_id
 and analytics.profile_id = profile.id
 and analytics.deleted_at is null
where group_row.deleted_at is null
  and event.counted_at is not null;

comment on view public.group_profile_export_rows is
  'Linhas da planilha de grupos. connection_label diz de onde o perfil publica: app da Meta ou conta Zernio, e na linha de queda o rotulo congelado no incidente.';

revoke all on public.group_profile_export_rows from public, anon;
grant select on public.group_profile_export_rows to authenticated, service_role;

notify pgrst, 'reload schema';
