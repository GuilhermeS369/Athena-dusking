-- A capacidade usada pela reserva OAuth deve ser visível e editável na fonte
-- de verdade, não apenas no planejador visual de Bulk.

drop view public.zernio_connections_safe;

create view public.zernio_connections_safe
with (security_invoker = true)
as
select
  connection.id,
  connection.organization_id,
  connection.label,
  true as configured,
  connection.zernio_profile_id,
  connection.status,
  connection.balance_cents,
  connection.balance_currency,
  connection.supported_platforms,
  connection.instagram_slot_limit,
  connection.last_checked_at,
  connection.last_success_at,
  connection.last_failure_at,
  connection.last_sync_at,
  connection.last_error_code,
  connection.last_error_message,
  connection.created_by,
  connection.deleted_at,
  connection.created_at,
  connection.updated_at,
  coalesce((
    select count(*)::integer
    from public.instagram_profiles profile
    where profile.organization_id = connection.organization_id
      and profile.provider = 'zernio'
      and profile.zernio_connection_id = connection.id
      and profile.deleted_at is null
  ), 0) as instagram_profile_count,
  coalesce((
    select count(*)::integer
    from public.zernio_connection_slot_reservations reservation
    where reservation.organization_id = connection.organization_id
      and reservation.zernio_connection_id = connection.id
      and reservation.released_at is null
      and reservation.expires_at > timezone('utc', now())
  ), 0) as active_slot_reservation_count,
  jsonb_build_object(
    'instagram', coalesce((
      select count(*)::integer
      from public.instagram_profiles profile
      where profile.organization_id = connection.organization_id
        and profile.provider = 'zernio'
        and profile.zernio_connection_id = connection.id
        and profile.deleted_at is null
    ), 0),
    'tiktok', 0,
    'youtube', 0
  ) as platform_counts
from public.zernio_connections connection;

grant select on public.zernio_connections_safe to authenticated;
