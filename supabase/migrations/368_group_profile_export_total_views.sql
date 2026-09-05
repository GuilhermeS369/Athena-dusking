-- Acrescenta à projeção de exportação três colunas que já existiam no banco e
-- não chegavam à planilha: o profile_id (a view nascia sem chave nenhuma), o
-- total de views do perfil e a data em que esse total foi sincronizado.
--
-- A origem das views é a mesma que a tela de perfis usa — profile_analytics_current,
-- alimentada pelo worker de analytics. Nada aqui sincroniza nem chama a API: é
-- leitura do que o banco já tem.
--
-- Para a linha 'fallen' o número certo NÃO é o current: um perfil caído parou de
-- sincronizar, e o incidente já congela o total no instante da queda (migration
-- 183). Por isso o snapshot vem primeiro, com o current como reserva para
-- incidentes anteriores àquela migration, que nasceram sem snapshot.
--
-- `create or replace view` exige que as colunas antigas fiquem com o mesmo nome,
-- tipo e posição; as novas entram no fim, então a ordem abaixo é obrigatória.

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
  and event.counted_at is not null;

revoke all on public.group_profile_export_rows from public, anon;
grant select on public.group_profile_export_rows to authenticated, service_role;

notify pgrst, 'reload schema';
