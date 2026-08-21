-- Fase 3 (base não destrutiva): os dois caminhos de reconciliação registram o
-- mesmo snapshot presente/ausente. Ausência só vira suspeita após duas leituras
-- completas consecutivas e não remove nem altera o perfil automaticamente.

create table public.zernio_remote_inventory_observations (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  zernio_connection_id uuid not null references public.zernio_connections(id) on delete cascade,
  profile_id uuid not null references public.instagram_profiles(id) on delete cascade,
  zernio_account_id text,
  state text not null default 'present' check (state in ('present', 'absence_observed', 'suspected_absent')),
  present_remote boolean not null default true,
  consecutive_absences integer not null default 0 check (consecutive_absences >= 0),
  last_present_at timestamptz,
  last_absent_at timestamptz,
  checked_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (zernio_connection_id, profile_id)
);

create trigger zernio_remote_inventory_observations_set_updated_at
before update on public.zernio_remote_inventory_observations
for each row execute function public.set_updated_at();

create index zernio_remote_inventory_observations_org_state_idx
  on public.zernio_remote_inventory_observations(organization_id, state, checked_at desc);

alter table public.zernio_remote_inventory_observations enable row level security;
create policy zernio_remote_inventory_observations_select_operator
  on public.zernio_remote_inventory_observations for select to authenticated
  using (public.has_organization_role(organization_id, array['admin', 'operator']::public.organization_role[]));

create or replace function public.record_zernio_connection_inventory_snapshot(
  p_organization_id uuid,
  p_zernio_connection_id uuid,
  p_remote_account_ids text[],
  p_complete_snapshot boolean default true
)
returns table(present_count integer, absence_observed_count integer, suspected_absent_count integer)
language plpgsql security definer set search_path = public as $$
declare checked_at_value timestamptz := timezone('utc', now());
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;
  if not exists (
    select 1 from public.zernio_connections
    where id = p_zernio_connection_id and organization_id = p_organization_id and deleted_at is null
  ) then
    raise exception using errcode = 'P0002', message = 'Conexão Zernio ativa não encontrada.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':' || p_zernio_connection_id::text || ':inventory', 0));

  insert into public.zernio_remote_inventory_observations (
    organization_id, zernio_connection_id, profile_id, zernio_account_id,
    state, present_remote, consecutive_absences, last_present_at, last_absent_at, checked_at
  )
  select
    profile.organization_id, profile.zernio_connection_id, profile.id, profile.zernio_account_id,
    case
      when profile.zernio_account_id = any(coalesce(p_remote_account_ids, '{}'::text[])) then 'present'
      else 'absence_observed'
    end,
    profile.zernio_account_id = any(coalesce(p_remote_account_ids, '{}'::text[])),
    case when profile.zernio_account_id = any(coalesce(p_remote_account_ids, '{}'::text[])) then 0 else 1 end,
    case when profile.zernio_account_id = any(coalesce(p_remote_account_ids, '{}'::text[])) then checked_at_value else null end,
    case when profile.zernio_account_id = any(coalesce(p_remote_account_ids, '{}'::text[])) then null else checked_at_value end,
    checked_at_value
  from public.instagram_profiles profile
  where profile.organization_id = p_organization_id
    and profile.zernio_connection_id = p_zernio_connection_id
    and profile.provider = 'zernio'
    and profile.deleted_at is null
    and (
      p_complete_snapshot
      or profile.zernio_account_id = any(coalesce(p_remote_account_ids, '{}'::text[]))
    )
  on conflict (zernio_connection_id, profile_id) do update set
    zernio_account_id = excluded.zernio_account_id,
    present_remote = excluded.present_remote,
    consecutive_absences = case
      when excluded.present_remote then 0
      else public.zernio_remote_inventory_observations.consecutive_absences + 1
    end,
    state = case
      when excluded.present_remote then 'present'
      when public.zernio_remote_inventory_observations.consecutive_absences + 1 >= 2 then 'suspected_absent'
      else 'absence_observed'
    end,
    last_present_at = case
      when excluded.present_remote then checked_at_value
      else public.zernio_remote_inventory_observations.last_present_at
    end,
    last_absent_at = case
      when excluded.present_remote then public.zernio_remote_inventory_observations.last_absent_at
      else checked_at_value
    end,
    checked_at = checked_at_value;

  return query
  select
    count(*) filter (where observation.state = 'present')::integer,
    count(*) filter (where observation.state = 'absence_observed')::integer,
    count(*) filter (where observation.state = 'suspected_absent')::integer
  from public.zernio_remote_inventory_observations observation
  where observation.organization_id = p_organization_id
    and observation.zernio_connection_id = p_zernio_connection_id;
end;
$$;

revoke all on public.zernio_remote_inventory_observations from public, anon, authenticated;
grant select on public.zernio_remote_inventory_observations to authenticated;
grant all on public.zernio_remote_inventory_observations to service_role;
revoke all on function public.record_zernio_connection_inventory_snapshot(uuid, uuid, text[], boolean) from public, anon, authenticated;
grant execute on function public.record_zernio_connection_inventory_snapshot(uuid, uuid, text[], boolean) to service_role;

notify pgrst, 'reload schema';
