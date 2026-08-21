-- Mantém a leitura da fila por cursor eficiente e com ordenação determinística.
-- A busca usa organization_id, created_at e id nesta mesma ordem.
create index if not exists publication_batches_org_created_id_page_idx
  on public.publication_batches (organization_id, created_at desc, id desc);
