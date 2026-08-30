-- Fecha a migração de storage: marca como 'r2' o acervo que já foi copiado.
--
-- A migration 332 criou `media_assets.storage_backend` e ensinou
-- `media_asset_has_storage_object` a aceitar mídia do R2, mas não fez o
-- backfill: só o que subiu depois da virada nasce com 'r2'. Em 30/08/2026 havia
-- 1.675 mídias vivas ainda marcadas como 'supabase' contra 115 marcadas 'r2',
-- mesmo com o arquivo íntegro no bucket do R2.
--
-- Enquanto ficarem marcadas assim, elas só passam no filtro da galeria pelo
-- ramo que consulta `storage.objects`, ou seja, dependem das cópias antigas
-- continuarem no Supabase Storage. No dia em que alguém limpar aquele bucket —
-- o passo natural para parar de pagar dois storages — 1.675 mídias somem da
-- galeria, do compositor e dos planos em lote de uma vez, exatamente o sintoma
-- que a 332 corrigiu para as mídias novas.
--
-- Conferido antes de escrever esta migration, comparando `media_assets` com o
-- ListObjectsV2 do bucket `instagram-media` no R2: das 1.790 mídias vivas,
-- 0 estavam sem o arquivo original no R2 (1 sem a miniatura). O backfill é
-- seguro justamente porque a cópia já aconteceu.
--
-- Só as mídias vivas são atualizadas: linhas com `deleted_at` preenchido não
-- passam por nenhum filtro de listagem e não ganham nada com a marcação.

update public.media_assets
set storage_backend = 'r2'
where deleted_at is null
  and storage_backend <> 'r2';
