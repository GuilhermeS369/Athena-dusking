-- Libera checksums presos por registros quebrados que não podem ser apagados
-- por FK com publication_item_media. O histórico fica preservado, mas o checksum
-- original deixa de bloquear um novo upload correto.

update public.media_assets asset
set
  checksum_sha256 = substr(md5(asset.id::text || ':broken-a') || md5(asset.id::text || ':broken-b'), 1, 64),
  status = 'failed',
  processing_error = coalesce(asset.processing_error || E'\n', '') || 'Registro antigo quebrado liberado para reenvio pela migration 050.',
  deleted_at = coalesce(asset.deleted_at, timezone('utc', now()))
where (
    asset.deleted_at is not null
    or not public.media_asset_has_storage_object(asset.storage_path)
  )
  and exists (
    select 1
    from public.publication_item_media link
    where link.media_asset_id = asset.id
  );

delete from public.media_assets asset
where (
    asset.deleted_at is not null
    or not public.media_asset_has_storage_object(asset.storage_path)
  )
  and not exists (
    select 1
    from public.publication_item_media link
    where link.media_asset_id = asset.id
  );
