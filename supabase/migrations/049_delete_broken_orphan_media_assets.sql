-- Remove registros de mídia que ficaram quebrados por falhas anteriores no fluxo
-- de upload: registros invisíveis na galeria porque não possuem mais objeto físico
-- no bucket, ou registros soft-deletados que ainda bloqueiam o reenvio pelo checksum.
--
-- Segurança: não remove mídia usada por publicações/agendamentos, porque esses
-- vínculos precisam ser tratados manualmente para não corromper histórico/fila.

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
