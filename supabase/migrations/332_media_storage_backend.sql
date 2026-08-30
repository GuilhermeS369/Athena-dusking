-- Galeria voltou a esconder mídias novas depois da migração do storage para o R2.
--
-- `media_asset_has_storage_object` (migration 047) protege a galeria, o
-- compositor e os planos em lote contra registros cujo arquivo físico sumiu —
-- mas ela só enxerga `storage.objects`, ou seja, apenas o Supabase Storage.
-- Com `MEDIA_STORAGE_BACKEND=r2` o upload passou a gravar somente no R2, então
-- toda mídia enviada depois da virada passou nesse filtro como "arquivo
-- ausente" e sumiu da interface, mesmo com o objeto íntegro no bucket.
--
-- O histórico antigo foi copiado para o R2 sem apagar os originais do Supabase
-- (ver lib/storage/media-storage.ts), por isso só as mídias novas sumiram.
--
-- A correção registra em qual backend cada mídia foi gravada e faz a função
-- considerar presente também o que está marcado como R2. Assinatura mantida:
-- todas as funções que já chamam essa checagem (galeria, compositor, contagem,
-- exclusão em lote, planos de rotação) passam a enxergar as mídias do R2 sem
-- precisar ser reescritas.

alter table public.media_assets
  add column if not exists storage_backend text not null default 'supabase';

alter table public.media_assets
  drop constraint if exists media_assets_storage_backend_check;

alter table public.media_assets
  add constraint media_assets_storage_backend_check
  check (storage_backend in ('supabase', 'r2'));

-- Índice parcial: a função abaixo procura pelo caminho apenas entre as mídias
-- marcadas como R2, que hoje são a minoria das linhas.
create index if not exists media_assets_r2_storage_path_idx
  on public.media_assets (storage_path)
  where storage_backend = 'r2';

create or replace function public.media_asset_has_storage_object(p_storage_path text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.media_assets asset
    where asset.storage_path = p_storage_path
      and asset.storage_backend = 'r2'
  ) or exists (
    select 1
    from storage.objects object_row
    where object_row.bucket_id = 'instagram-media'
      and object_row.name = p_storage_path
  );
$$;

revoke all on function public.media_asset_has_storage_object(text) from public, anon;
grant execute on function public.media_asset_has_storage_object(text) to authenticated, service_role;
