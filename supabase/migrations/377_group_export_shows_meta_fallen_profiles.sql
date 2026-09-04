-- O XLSX passa a mostrar tambem os perfis caidos pela META.
--
-- A view tinha dois ramos: os perfis atuais do grupo, e os caidos pela Zernio.
-- Quem caiu pela Meta nao aparecia em nenhum dos dois -- `profile_group_members`
-- ja tinha sido apagada e `profile.deleted_at` esta preenchido, entao o perfil
-- some do primeiro ramo e nao tem lugar no segundo. Na planilha ele simplesmente
-- desaparecia, que e o pior desfecho possivel: o grupo encolhe e ninguem sabe
-- por que.
--
-- O ramo novo le o par criado pela migration 373 (incidente + evento de saida do
-- grupo) e monta a linha `fallen` do mesmo jeito que o ramo da Zernio monta.
--
-- `zernio_connection_label` mantem o nome por compatibilidade -- e a coluna que a
-- planilha ja consome -- mas para a Meta ela carrega o rotulo do APP. Renomear
-- exigiria mexer no gerador do XLSX e nas duas telas que leem a view, sem ganho
-- para quem olha a planilha.
--
-- O motivo da queda e fixo ("Verificação exigida pela Meta") porque, ao
-- contrario da Zernio, aqui so existe um sinal: a regra em
-- `isMetaTerminalProfileDisconnection` exige codigo 190 com mensagem de
-- checkpoint. Token expirado nao chega aqui -- fica com o worker de renovacao.
--
-- `create or replace view` exige mesmo nome, tipo e posicao das colunas antigas.
-- A ordem abaixo e a da migration 368 e nao pode mudar.

create or replace view public.group_profile_export_rows
with (security_invoker = true)
as
select
  group_row.organization_id,
  group_row.id as group_id,
  group_row.name as group_name,
  group_row.consumption_mode::text as group_consumption_mode,
  'current'::text as row_kind,
  profile.username,
  connection.label as zernio_connection_label,
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
  incident.connection_label_snapshot as zernio_connection_label,
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
  incident.meta_app_label_snapshot as zernio_connection_label,
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

revoke all on public.group_profile_export_rows from public, anon;
grant select on public.group_profile_export_rows to authenticated, service_role;

notify pgrst, 'reload schema';
