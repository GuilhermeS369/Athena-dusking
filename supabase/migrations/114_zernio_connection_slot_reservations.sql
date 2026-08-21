-- Reserva de capacidade antes de abrir o OAuth Zernio. A reserva é local,
-- curta e transacional: duas telas nunca recebem o mesmo último slot.

alter table public.zernio_connections
  add column instagram_slot_limit integer not null default 2
  check (instagram_slot_limit between 1 and 100);

create table public.zernio_connection_slot_reservations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  zernio_connection_id uuid not null references public.zernio_connections(id) on delete cascade,
  reserved_by uuid not null references auth.users(id) on delete restrict,
  requested_connection_id uuid references public.zernio_connections(id) on delete set null,
  expires_at timestamptz not null,
  released_at timestamptz,
  release_reason text,
  created_at timestamptz not null default timezone('utc', now()),
  check (expires_at > created_at)
);

create index zernio_connection_slot_reservations_active_idx
  on public.zernio_connection_slot_reservations (organization_id, zernio_connection_id, expires_at)
  where released_at is null;

alter table public.zernio_connection_attempts
  add column zernio_slot_reservation_id uuid
  references public.zernio_connection_slot_reservations(id) on delete set null;

create unique index zernio_connection_attempts_slot_reservation_idx
  on public.zernio_connection_attempts (zernio_slot_reservation_id)
  where zernio_slot_reservation_id is not null;

create or replace function public.reserve_zernio_connection_slot(
  p_organization_id uuid,
  p_requested_connection_id uuid,
  p_reserved_by uuid,
  p_lease_seconds integer default 720
)
returns table (
  reservation_id uuid,
  zernio_connection_id uuid,
  connection_label text,
  used_slots integer,
  slot_limit integer,
  fallback_used boolean
)
language plpgsql security definer set search_path = public as $$
declare
  selected_connection_id uuid;
  selected_connection_label text;
  selected_slot_limit integer;
  selected_used_slots integer;
  normalized_lease_seconds integer := greatest(120, least(coalesce(p_lease_seconds, 720), 1800));
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;

  if not exists (
    select 1 from public.zernio_connections
    where id = p_requested_connection_id
      and organization_id = p_organization_id
      and deleted_at is null
  ) then
    raise exception using errcode = 'P0002', message = 'Conta Zernio solicitada não encontrada.';
  end if;

  -- Serializa somente as escolhas desta organização; a chamada externa à Zernio
  -- permanece fora da transação e não prolonga o bloqueio.
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':zernio-slot', 0));

  update public.zernio_connection_slot_reservations
  set released_at = timezone('utc', now()), release_reason = 'expired'
  where organization_id = p_organization_id
    and released_at is null
    and expires_at <= timezone('utc', now());

  with capacity as (
    select
      connection.id,
      connection.label,
      connection.instagram_slot_limit,
      (
        select count(*)::integer
        from public.instagram_profiles profile
        where profile.organization_id = connection.organization_id
          and profile.provider = 'zernio'
          and profile.zernio_connection_id = connection.id
          and profile.deleted_at is null
      ) as active_profiles,
      (
        select count(*)::integer
        from public.zernio_connection_slot_reservations reservation
        where reservation.organization_id = connection.organization_id
          and reservation.zernio_connection_id = connection.id
          and reservation.released_at is null
          and reservation.expires_at > timezone('utc', now())
      ) as active_reservations
    from public.zernio_connections connection
    where connection.organization_id = p_organization_id
      and connection.deleted_at is null
      and connection.status in ('online', 'no_data')
  ), candidates as (
    select *, active_profiles + active_reservations as used_slots
    from capacity
    where active_profiles + active_reservations < instagram_slot_limit
  )
  select candidates.id, candidates.label, candidates.instagram_slot_limit, candidates.used_slots
  into selected_connection_id, selected_connection_label, selected_slot_limit, selected_used_slots
  from candidates
  order by
    case when candidates.id = p_requested_connection_id then 0 else 1 end,
    candidates.used_slots,
    candidates.label collate "C",
    candidates.id
  limit 1;

  if not found then
    raise exception using errcode = 'P0001', message = 'Nenhuma conta Zernio com slot livre está disponível agora.';
  end if;

  insert into public.zernio_connection_slot_reservations (
    organization_id, zernio_connection_id, reserved_by, requested_connection_id, expires_at
  ) values (
    p_organization_id, selected_connection_id, p_reserved_by, p_requested_connection_id,
    timezone('utc', now()) + make_interval(secs => normalized_lease_seconds)
  ) returning id into reservation_id;

  zernio_connection_id := selected_connection_id;
  connection_label := selected_connection_label;
  used_slots := selected_used_slots;
  slot_limit := selected_slot_limit;
  fallback_used := selected_connection_id <> p_requested_connection_id;
  return next;
end;
$$;

create or replace function public.release_zernio_connection_slot_reservation(
  p_reservation_id uuid,
  p_organization_id uuid,
  p_reason text
)
returns boolean language plpgsql security definer set search_path = public as $$
declare released boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;
  update public.zernio_connection_slot_reservations
  set released_at = timezone('utc', now()), release_reason = left(coalesce(nullif(trim(p_reason), ''), 'released'), 120)
  where id = p_reservation_id
    and organization_id = p_organization_id
    and released_at is null
  returning true into released;
  return coalesce(released, false);
end;
$$;

revoke all on public.zernio_connection_slot_reservations from public, anon, authenticated;
grant all on public.zernio_connection_slot_reservations to service_role;
revoke all on function public.reserve_zernio_connection_slot(uuid, uuid, uuid, integer), public.release_zernio_connection_slot_reservation(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.reserve_zernio_connection_slot(uuid, uuid, uuid, integer), public.release_zernio_connection_slot_reservation(uuid, uuid, text) to service_role;
