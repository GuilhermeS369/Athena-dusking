-- Athena Scheduler: biblioteca privada de mídia por organização.

create type public.media_asset_status as enum (
  'uploaded',
  'processing',
  'ready',
  'failed',
  'deleted'
);

create type public.media_asset_kind as enum (
  'image',
  'video'
);

create table public.media_assets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  uploaded_by uuid not null references auth.users (id) on delete restrict,
  storage_path text not null check (char_length(storage_path) between 10 and 500),
  original_name text not null check (char_length(trim(original_name)) between 1 and 255),
  mime_type text not null check (char_length(mime_type) between 3 and 120),
  kind public.media_asset_kind not null,
  size_bytes bigint not null check (size_bytes > 0),
  checksum_sha256 text not null check (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  duration_ms integer check (duration_ms is null or duration_ms > 0),
  status public.media_asset_status not null default 'uploaded',
  processing_error text,
  deleted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (organization_id, checksum_sha256)
);

create index media_assets_org_status_idx
  on public.media_assets (organization_id, status, created_at desc)
  where deleted_at is null;

create index media_assets_org_kind_idx
  on public.media_assets (organization_id, kind, created_at desc)
  where deleted_at is null;

create trigger media_assets_set_updated_at
before update on public.media_assets
for each row execute function public.set_updated_at();

alter table public.media_assets enable row level security;

create policy media_assets_select_member
on public.media_assets for select
to authenticated
using (public.is_organization_member(organization_id));

create policy media_assets_insert_operator
on public.media_assets for insert
to authenticated
with check (
  uploaded_by = (select auth.uid())
  and public.has_organization_role(
    organization_id,
    array['admin', 'operator']::public.organization_role[]
  )
);

create policy media_assets_update_operator
on public.media_assets for update
to authenticated
using (
  public.has_organization_role(
    organization_id,
    array['admin', 'operator']::public.organization_role[]
  )
)
with check (
  public.has_organization_role(
    organization_id,
    array['admin', 'operator']::public.organization_role[]
  )
);

create policy media_assets_delete_operator
on public.media_assets for delete
to authenticated
using (
  public.has_organization_role(
    organization_id,
    array['admin', 'operator']::public.organization_role[]
  )
);

revoke all on table public.media_assets from anon;
grant select, insert, update, delete on table public.media_assets to authenticated;

insert into storage.buckets (id, name, public)
values ('instagram-media', 'instagram-media', false)
on conflict (id) do update set public = false;

create policy media_objects_select_member
on storage.objects for select
to authenticated
using (
  bucket_id = 'instagram-media'
  and public.is_organization_member((storage.foldername(name))[1]::uuid)
);

create policy media_objects_insert_operator
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'instagram-media'
  and public.has_organization_role(
    (storage.foldername(name))[1]::uuid,
    array['admin', 'operator']::public.organization_role[]
  )
  and owner_id = (select auth.uid())::text
);

create policy media_objects_update_operator
on storage.objects for update
to authenticated
using (
  bucket_id = 'instagram-media'
  and public.has_organization_role(
    (storage.foldername(name))[1]::uuid,
    array['admin', 'operator']::public.organization_role[]
  )
)
with check (
  bucket_id = 'instagram-media'
  and public.has_organization_role(
    (storage.foldername(name))[1]::uuid,
    array['admin', 'operator']::public.organization_role[]
  )
);

create policy media_objects_delete_operator
on storage.objects for delete
to authenticated
using (
  bucket_id = 'instagram-media'
  and public.has_organization_role(
    (storage.foldername(name))[1]::uuid,
    array['admin', 'operator']::public.organization_role[]
  )
);
