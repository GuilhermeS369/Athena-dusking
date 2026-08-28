create or replace view public.instagram_observability_events_enriched
with (security_invoker = true)
as
select
  event.*,
  profile.username as profile_username,
  profile.display_name as profile_display_name,
  profile.provider as profile_provider,
  source_group.name as source_group_name,
  connection.label as connection_label
from public.instagram_observability_events as event
left join public.instagram_profiles as profile
  on profile.id = event.profile_id
 and profile.organization_id = event.organization_id
 and profile.deleted_at is null
left join public.profile_groups as source_group
  on source_group.id = event.source_group_id
 and source_group.organization_id = event.organization_id
left join public.zernio_connections as connection
  on connection.id = event.connection_id
 and connection.organization_id = event.organization_id
 and connection.deleted_at is null;

revoke all on public.instagram_observability_events_enriched from public, anon, authenticated;
grant select on public.instagram_observability_events_enriched to service_role;

comment on view public.instagram_observability_events_enriched is
  'Internal service-role projection that enriches a timeline event without extra API round trips.';
