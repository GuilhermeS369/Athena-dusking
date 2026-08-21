-- A composição por perfil pode gerar várias publicações simples no mesmo lote.
alter table public.publication_items
  drop constraint if exists publication_items_batch_id_profile_id_key;

create index if not exists publication_items_batch_profile_idx
  on public.publication_items (organization_id, batch_id, profile_id, created_at);
