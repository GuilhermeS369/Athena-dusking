-- Registra, sem interferir na reciclagem existente, o grupo ao qual pertencia
-- cada perfil removido por account_disconnected ou auth_expired. O evento é
-- capturado no DELETE do vínculo e só passa a contar após a conclusão remota.

create table public.zernio_group_profile_removal_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  group_id uuid not null references public.profile_groups(id) on delete cascade,
  profile_id uuid not null references public.instagram_profiles(id) on delete restrict,
  incident_id uuid not null references public.zernio_profile_disconnection_incidents(id) on delete cascade,
  removal_sequence integer not null check (removal_sequence >= 1),
  signal text not null check (signal in ('account_disconnected', 'auth_expired')),
  counted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  unique (incident_id, removal_sequence)
);

create index zernio_group_profile_removal_events_group_count_idx
  on public.zernio_group_profile_removal_events(organization_id, group_id, counted_at)
  where counted_at is not null;

alter table public.zernio_group_profile_removal_events enable row level security;

create policy zernio_group_profile_removal_events_select_member
  on public.zernio_group_profile_removal_events for select to authenticated
  using (public.is_organization_member(organization_id));

revoke all on public.zernio_group_profile_removal_events from public, anon, authenticated;
grant select on public.zernio_group_profile_removal_events to authenticated;
grant all on public.zernio_group_profile_removal_events to service_role;

create or replace function public.capture_zernio_group_profile_removal_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  incident_row public.zernio_profile_disconnection_incidents%rowtype;
  next_sequence integer;
begin
  -- Remoções manuais de membros do grupo não representam queda de perfil.
  if coalesce(auth.role(), '') <> 'service_role' then
    return old;
  end if;

  select incident.* into incident_row
  from public.zernio_profile_disconnection_incidents incident
  where incident.organization_id = old.organization_id
    and incident.profile_id = old.profile_id
    and incident.signal in ('account_disconnected', 'auth_expired')
    and incident.state = 'remote_removal_pending'
    and incident.finalized_at is null
  order by incident.detected_at desc, incident.id desc
  limit 1
  for update;

  if not found then
    return old;
  end if;

  select coalesce(max(event.removal_sequence), 0) + 1
  into next_sequence
  from public.zernio_group_profile_removal_events event
  where event.incident_id = incident_row.id;

  insert into public.zernio_group_profile_removal_events (
    organization_id, group_id, profile_id, incident_id, removal_sequence, signal
  ) values (
    old.organization_id, old.group_id, old.profile_id,
    incident_row.id, next_sequence, incident_row.signal
  );

  return old;
end;
$$;

drop trigger if exists profile_group_members_capture_zernio_removal
  on public.profile_group_members;
create trigger profile_group_members_capture_zernio_removal
before delete on public.profile_group_members
for each row execute function public.capture_zernio_group_profile_removal_event();

create or replace function public.finalize_zernio_group_profile_removal_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.signal in ('account_disconnected', 'auth_expired')
    and new.state = 'completed'
    and new.remote_result in ('remote_deleted', 'already_disconnected_404')
  then
    update public.zernio_group_profile_removal_events event
    set counted_at = coalesce(new.finalized_at, timezone('utc', now()))
    where event.incident_id = new.id
      and event.counted_at is null;
  end if;

  return new;
end;
$$;

drop trigger if exists zernio_disconnection_incidents_finalize_group_removal
  on public.zernio_profile_disconnection_incidents;
create trigger zernio_disconnection_incidents_finalize_group_removal
after update of state, remote_result, finalized_at
on public.zernio_profile_disconnection_incidents
for each row execute function public.finalize_zernio_group_profile_removal_event();

create or replace view public.zernio_group_profile_removal_counts
with (security_invoker = true)
as
select
  event.organization_id,
  event.group_id,
  count(*)::integer as fallen_profile_count
from public.zernio_group_profile_removal_events event
where event.counted_at is not null
group by event.organization_id, event.group_id;

revoke all on public.zernio_group_profile_removal_counts from public, anon;
grant select on public.zernio_group_profile_removal_counts to authenticated, service_role;

revoke all on function public.capture_zernio_group_profile_removal_event() from public, anon, authenticated;
revoke all on function public.finalize_zernio_group_profile_removal_event() from public, anon, authenticated;

notify pgrst, 'reload schema';
