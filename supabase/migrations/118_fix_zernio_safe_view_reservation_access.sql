-- A view é security_invoker para manter o isolamento de organizações. A tabela
-- de reservas, porém, é deliberadamente privada. Contamos reservas por uma
-- função security definer que ainda valida a associação do usuário à organização.

create or replace function public.active_zernio_connection_slot_reservation_count(
  p_organization_id uuid,
  p_zernio_connection_id uuid
)
returns integer
language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' and not public.is_organization_member(p_organization_id) then
    return 0;
  end if;

  return coalesce((
    select count(*)::integer
    from public.zernio_connection_slot_reservations reservation
    where reservation.organization_id = p_organization_id
      and reservation.zernio_connection_id = p_zernio_connection_id
      and reservation.released_at is null
      and reservation.expires_at > timezone('utc', now())
  ), 0);
end;
$$;

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
  public.active_zernio_connection_slot_reservation_count(connection.organization_id, connection.id) as active_slot_reservation_count,
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

revoke all on function public.active_zernio_connection_slot_reservation_count(uuid, uuid) from public, anon;
grant execute on function public.active_zernio_connection_slot_reservation_count(uuid, uuid) to authenticated, service_role;
grant select on public.zernio_connections_safe to authenticated;
