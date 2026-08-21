-- Linhas de exportação de um grupo: membros atuais e perfis cuja queda Zernio
-- foi confirmada. Esta projeção apenas lê o histórico já capturado pelo fluxo
-- de reciclagem; ela não altera exclusões, reconexões nem chamadas à Zernio.

create index if not exists zernio_group_profile_removal_events_export_idx
  on public.zernio_group_profile_removal_events (organization_id, group_id, counted_at desc, incident_id)
  where counted_at is not null;

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
  null::text as fall_reason
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
  ) as fall_reason
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
where group_row.deleted_at is null
  and event.counted_at is not null;

revoke all on public.group_profile_export_rows from public, anon;
grant select on public.group_profile_export_rows to authenticated, service_role;

notify pgrst, 'reload schema';
