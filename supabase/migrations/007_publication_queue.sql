-- Athena Scheduler: unidades de publicação e fila persistente idempotente.

create type public.publication_format as enum (
  'image',
  'reel',
  'story',
  'carousel'
);

create type public.publication_batch_status as enum (
  'draft',
  'validating',
  'queued',
  'processing',
  'completed',
  'completed_with_errors',
  'cancelled'
);

create type public.publication_item_status as enum (
  'draft',
  'validating',
  'reserved',
  'waiting',
  'preparing',
  'ready',
  'publishing',
  'published',
  'failed',
  'ignored',
  'cancelled',
  'removed'
);

create table public.publication_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  created_by uuid not null references auth.users (id) on delete restrict,
  name text check (name is null or char_length(trim(name)) between 1 and 160),
  status public.publication_batch_status not null default 'draft',
  scheduled_for timestamptz,
  timezone text not null default 'America/Sao_Paulo' check (timezone = 'America/Sao_Paulo'),
  review_confirmed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.publication_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  batch_id uuid not null references public.publication_batches (id) on delete cascade,
  profile_id uuid not null references public.instagram_profiles (id) on delete restrict,
  format public.publication_format not null,
  status public.publication_item_status not null default 'draft',
  execute_at timestamptz,
  caption text check (caption is null or char_length(caption) <= 2200),
  idempotency_key text not null check (char_length(trim(idempotency_key)) between 16 and 240),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz,
  lease_until timestamptz,
  claimed_by text,
  creation_id text,
  meta_media_id text,
  last_error_code text,
  last_error_message text,
  published_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (organization_id, idempotency_key),
  unique (batch_id, profile_id)
);

create table public.publication_item_media (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  publication_item_id uuid not null references public.publication_items (id) on delete cascade,
  media_asset_id uuid not null references public.media_assets (id) on delete restrict,
  position integer not null check (position >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  primary key (publication_item_id, position),
  unique (publication_item_id, media_asset_id)
);

create index publication_batches_org_status_idx
  on public.publication_batches (organization_id, status, updated_at desc);

create index publication_items_dispatch_idx
  on public.publication_items (organization_id, status, execute_at, next_attempt_at)
  where status in ('waiting', 'preparing', 'ready', 'failed');

create index publication_items_batch_idx
  on public.publication_items (organization_id, batch_id, created_at);

create index publication_item_media_asset_idx
  on public.publication_item_media (organization_id, media_asset_id);

create or replace function public.enforce_publication_organization()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.publication_batches batch_row
    where batch_row.id = new.batch_id
      and batch_row.organization_id = new.organization_id
  ) then
    raise exception using errcode = '23514', message = 'Lote e item devem pertencer à mesma organização';
  end if;

  if not exists (
    select 1 from public.instagram_profiles profile_row
    where profile_row.id = new.profile_id
      and profile_row.organization_id = new.organization_id
      and profile_row.deleted_at is null
  ) then
    raise exception using errcode = '23514', message = 'Perfil inválido para a organização';
  end if;

  return new;
end;
$$;

create or replace function public.enforce_publication_media_organization()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.publication_items item_row
    join public.media_assets asset on asset.id = new.media_asset_id
    where item_row.id = new.publication_item_id
      and item_row.organization_id = new.organization_id
      and asset.organization_id = new.organization_id
      and asset.deleted_at is null
  ) then
    raise exception using errcode = '23514', message = 'Item e mídia devem pertencer à mesma organização ativa';
  end if;

  return new;
end;
$$;

create trigger publication_items_validate_organization
before insert or update on public.publication_items
for each row execute function public.enforce_publication_organization();

create trigger publication_item_media_validate_organization
before insert or update on public.publication_item_media
for each row execute function public.enforce_publication_media_organization();

create trigger publication_batches_set_updated_at
before update on public.publication_batches
for each row execute function public.set_updated_at();

create trigger publication_items_set_updated_at
before update on public.publication_items
for each row execute function public.set_updated_at();

alter table public.publication_batches enable row level security;
alter table public.publication_items enable row level security;
alter table public.publication_item_media enable row level security;

create policy publication_batches_select_member
on public.publication_batches for select to authenticated
using (public.is_organization_member(organization_id));

create policy publication_batches_insert_operator
on public.publication_batches for insert to authenticated
with check (
  created_by = (select auth.uid())
  and public.has_organization_role(organization_id, array['admin', 'operator']::public.organization_role[])
);

create policy publication_batches_update_operator
on public.publication_batches for update to authenticated
using (public.has_organization_role(organization_id, array['admin', 'operator']::public.organization_role[]))
with check (public.has_organization_role(organization_id, array['admin', 'operator']::public.organization_role[]));

create policy publication_batches_delete_operator
on public.publication_batches for delete to authenticated
using (public.has_organization_role(organization_id, array['admin', 'operator']::public.organization_role[]));

create policy publication_items_select_member
on public.publication_items for select to authenticated
using (public.is_organization_member(organization_id));

create policy publication_items_insert_operator
on public.publication_items for insert to authenticated
with check (public.has_organization_role(organization_id, array['admin', 'operator']::public.organization_role[]));

create policy publication_items_update_operator
on public.publication_items for update to authenticated
using (public.has_organization_role(organization_id, array['admin', 'operator']::public.organization_role[]))
with check (public.has_organization_role(organization_id, array['admin', 'operator']::public.organization_role[]));

create policy publication_items_media_select_member
on public.publication_item_media for select to authenticated
using (public.is_organization_member(organization_id));

create policy publication_items_media_insert_operator
on public.publication_item_media for insert to authenticated
with check (public.has_organization_role(organization_id, array['admin', 'operator']::public.organization_role[]));

create policy publication_items_media_delete_operator
on public.publication_item_media for delete to authenticated
using (public.has_organization_role(organization_id, array['admin', 'operator']::public.organization_role[]));

revoke all on table public.publication_batches, public.publication_items, public.publication_item_media from anon;
grant select, insert, update, delete on table public.publication_batches to authenticated;
grant select, insert, update on table public.publication_items to authenticated;
grant select, insert, delete on table public.publication_item_media to authenticated;

revoke all on function public.enforce_publication_organization() from public;
revoke all on function public.enforce_publication_media_organization() from public;
