-- Índices para paginação determinística da galeria e lookup das relações por mídia.

create index if not exists media_assets_gallery_available_page_idx
  on public.media_assets (organization_id, created_at desc, id desc)
  where deleted_at is null and first_published_at is null;

create index if not exists media_assets_gallery_posted_page_idx
  on public.media_assets (organization_id, created_at desc, id desc)
  where deleted_at is null and first_published_at is not null;

create index if not exists media_group_assignments_asset_idx
  on public.media_group_assignments (organization_id, media_asset_id, group_id);
