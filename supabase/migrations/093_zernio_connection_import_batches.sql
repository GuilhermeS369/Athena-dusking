-- Importação confiável de múltiplas API keys Zernio por organização.

create type public.zernio_connection_import_batch_status as enum (
  'queued',
  'processing',
  'completed',
  'completed_with_errors'
);

create type public.zernio_connection_import_item_status as enum (
  'queued',
  'processing',
  'succeeded',
  'failed'
);

create table public.zernio_connection_import_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  created_by uuid not null references auth.users (id) on delete restrict,
  status public.zernio_connection_import_batch_status not null default 'queued',
  total_count integer not null check (total_count > 0),
  created_at timestamptz not null default timezone('utc', now()),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default timezone('utc', now())
);

create index zernio_connection_import_batches_org_queue_idx
  on public.zernio_connection_import_batches (organization_id, status, created_at);

create trigger zernio_connection_import_batches_set_updated_at
before update on public.zernio_connection_import_batches
for each row execute function public.set_updated_at();

create table public.zernio_connection_import_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.zernio_connection_import_batches (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  line_number integer not null check (line_number > 0),
  label text not null check (char_length(trim(label)) between 2 and 80),
  encrypted_api_key text not null check (char_length(trim(encrypted_api_key)) between 16 and 2000),
  status public.zernio_connection_import_item_status not null default 'queued',
  attempts integer not null default 0 check (attempts >= 0),
  zernio_connection_id uuid references public.zernio_connections (id) on delete set null,
  last_error_message text,
  processing_started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (batch_id, line_number)
);

create index zernio_connection_import_items_batch_status_idx
  on public.zernio_connection_import_items (batch_id, status, line_number);

create trigger zernio_connection_import_items_set_updated_at
before update on public.zernio_connection_import_items
for each row execute function public.set_updated_at();

-- Um lease por organização impede dois funcionários (ou duas abas) de chamar a Zernio ao mesmo tempo.
create table public.zernio_connection_import_locks (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  batch_id uuid not null references public.zernio_connection_import_batches (id) on delete cascade,
  locked_by uuid not null,
  locked_until timestamptz not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create trigger zernio_connection_import_locks_set_updated_at
before update on public.zernio_connection_import_locks
for each row execute function public.set_updated_at();

create or replace function public.create_zernio_connection_import_batch(
  p_organization_id uuid,
  p_created_by uuid,
  p_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_batch_id uuid;
  item_count integer;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'O lote precisa conter ao menos uma linha válida.';
  end if;

  select count(*) into item_count
  from jsonb_array_elements(p_items) as item;

  insert into public.zernio_connection_import_batches (organization_id, created_by, total_count)
  values (p_organization_id, p_created_by, item_count)
  returning id into new_batch_id;

  insert into public.zernio_connection_import_items (
    batch_id, organization_id, line_number, label, encrypted_api_key
  )
  select
    new_batch_id,
    p_organization_id,
    (item.value ->> 'lineNumber')::integer,
    item.value ->> 'label',
    item.value ->> 'encryptedApiKey'
  from jsonb_array_elements(p_items) as item;

  return new_batch_id;
end;
$$;

create or replace function public.acquire_zernio_connection_import_lock(
  p_organization_id uuid,
  p_batch_id uuid,
  p_locked_by uuid,
  p_lease_seconds integer default 90
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
  lease_seconds := greatest(30, least(coalesce(p_lease_seconds, 90), 300));

  insert into public.zernio_connection_import_locks (
    organization_id, batch_id, locked_by, locked_until
  ) values (
    p_organization_id,
    p_batch_id,
    p_locked_by,
    timezone('utc', now()) + make_interval(secs => lease_seconds)
  )
  on conflict (organization_id)
  do update set
    batch_id = excluded.batch_id,
    locked_by = excluded.locked_by,
    locked_until = excluded.locked_until,
    updated_at = timezone('utc', now())
  where public.zernio_connection_import_locks.locked_until <= timezone('utc', now())
     or (
       public.zernio_connection_import_locks.batch_id = p_batch_id
       and public.zernio_connection_import_locks.locked_by = p_locked_by
     )
  returning true into claimed;

  return coalesce(claimed, false);
end;
$$;

create or replace function public.release_zernio_connection_import_lock(
  p_organization_id uuid,
  p_batch_id uuid,
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
  delete from public.zernio_connection_import_locks
  where organization_id = p_organization_id
    and batch_id = p_batch_id
    and locked_by = p_locked_by
  returning true into released;

  return coalesce(released, false);
end;
$$;

revoke all on public.zernio_connection_import_batches from public, anon, authenticated;
revoke all on public.zernio_connection_import_items from public, anon, authenticated;
revoke all on public.zernio_connection_import_locks from public, anon, authenticated;
grant all on public.zernio_connection_import_batches to service_role;
grant all on public.zernio_connection_import_items to service_role;
grant all on public.zernio_connection_import_locks to service_role;

revoke all on function public.create_zernio_connection_import_batch(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.acquire_zernio_connection_import_lock(uuid, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.release_zernio_connection_import_lock(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_zernio_connection_import_batch(uuid, uuid, jsonb) to service_role;
grant execute on function public.acquire_zernio_connection_import_lock(uuid, uuid, uuid, integer) to service_role;
grant execute on function public.release_zernio_connection_import_lock(uuid, uuid, uuid) to service_role;
