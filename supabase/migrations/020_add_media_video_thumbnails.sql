-- Miniatura persistida separadamente do vídeo para que toda interface possa
-- exibir uma prévia leve sem carregar ou reproduzir o arquivo de vídeo.
alter table public.media_assets
  add column thumbnail_storage_path text
    check (thumbnail_storage_path is null or char_length(thumbnail_storage_path) between 10 and 500);

create index media_assets_org_missing_thumbnail_idx
  on public.media_assets (organization_id, created_at asc)
  where deleted_at is null
    and kind = 'video'
    and thumbnail_storage_path is null;
