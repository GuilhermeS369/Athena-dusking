-- Athena Scheduler: auditoria e concorrência fina para conexões Zernio simultâneas.

create type public.zernio_connection_attempt_status as enum (
  'started',
  'redirected',
  'callback_received',
  'synced',
  'empty',
  'failed'
);

create table public.zernio_connection_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  zernio_connection_id uuid not null references public.zernio_connections (id) on delete cascade,
  created_by uuid not null references auth.users (id) on delete restrict,
  return_to text not null default '/perfis' check (char_length(trim(return_to)) between 1 and 500),
  status public.zernio_connection_attempt_status not null default 'started',
  zernio_profile_id text check (zernio_profile_id is null or char_length(trim(zernio_profile_id)) between 1 and 160),
  zernio_state text,
  request_user_agent text,
  request_ip text,
  auth_url_host text,
  sync_attempts integer not null default 0 check (sync_attempts >= 0),
  synced_count integer not null default 0 check (synced_count >= 0),
  zernio_account_ids text[] not null default '{}'::text[],
  new_zernio_account_ids text[] not null default '{}'::text[],
  diagnostic jsonb not null default '{}'::jsonb check (jsonb_typeof(diagnostic) = 'object'),
  last_error_message text,
  started_at timestamptz not null default timezone('utc', now()),
  redirected_at timestamptz,
  callback_received_at timestamptz,
  synced_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index zernio_connection_attempts_org_connection_status_idx
  on public.zernio_connection_attempts (organization_id, zernio_connection_id, status, created_at desc);

create index zernio_connection_attempts_user_created_idx
  on public.zernio_connection_attempts (created_by, created_at desc);

create trigger zernio_connection_attempts_set_updated_at
before update on public.zernio_connection_attempts
for each row execute function public.set_updated_at();

alter table public.zernio_connection_attempts enable row level security;

create policy zernio_connection_attempts_select_operator
on public.zernio_connection_attempts for select
to authenticated
using (public.has_organization_role(organization_id, array['admin', 'operator']::public.organization_role[]));

create table public.zernio_connection_operation_locks (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  zernio_connection_id uuid not null references public.zernio_connections (id) on delete cascade,
  locked_by uuid not null,
  locked_until timestamptz not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, zernio_connection_id)
);

create trigger zernio_connection_operation_locks_set_updated_at
before update on public.zernio_connection_operation_locks
for each row execute function public.set_updated_at();

alter table public.zernio_connection_operation_locks enable row level security;

create policy zernio_connection_operation_locks_select_admin
on public.zernio_connection_operation_locks for select
to authenticated
using (public.has_organization_role(organization_id, array['admin']::public.organization_role[]));

create or replace function public.acquire_zernio_connection_operation_lock(
  p_organization_id uuid,
  p_zernio_connection_id uuid,
  p_locked_by uuid,
  p_lease_seconds integer default 30
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed boolean;
  lease_seconds integer;
begin
  lease_seconds := greatest(5, least(coalesce(p_lease_seconds, 30), 120));

  insert into public.zernio_connection_operation_locks (
    organization_id,
    zernio_connection_id,
    locked_by,
    locked_until
  ) values (
    p_organization_id,
    p_zernio_connection_id,
    p_locked_by,
    timezone('utc', now()) + make_interval(secs => lease_seconds)
  )
  on conflict (organization_id, zernio_connection_id)
  do update set
    locked_by = excluded.locked_by,
    locked_until = excluded.locked_until,
    updated_at = timezone('utc', now())
  where public.zernio_connection_operation_locks.locked_until <= timezone('utc', now())
     or public.zernio_connection_operation_locks.locked_by = p_locked_by
  returning true into claimed;

  return coalesce(claimed, false);
end;
$$;

create or replace function public.release_zernio_connection_operation_lock(
  p_organization_id uuid,
  p_zernio_connection_id uuid,
  p_locked_by uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  released boolean;
begin
  delete from public.zernio_connection_operation_locks
  where organization_id = p_organization_id
    and zernio_connection_id = p_zernio_connection_id
    and locked_by = p_locked_by
  returning true into released;

  return coalesce(released, false);
end;
$$;

revoke all on public.zernio_connection_attempts from public, anon, authenticated;
revoke all on public.zernio_connection_operation_locks from public, anon, authenticated;
grant all on public.zernio_connection_attempts to service_role;
grant all on public.zernio_connection_operation_locks to service_role;

revoke all on function public.acquire_zernio_connection_operation_lock(uuid, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.release_zernio_connection_operation_lock(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.acquire_zernio_connection_operation_lock(uuid, uuid, uuid, integer) to service_role;
grant execute on function public.release_zernio_connection_operation_lock(uuid, uuid, uuid) to service_role;
