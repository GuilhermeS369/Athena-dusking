-- 423 — o arquivo frio espelha a coluna que a 420 criou na tabela quente.
--
-- A 420 (recuo de infraestrutura) adicionou `infrastructure_retry_count` em
-- `publication_items` e não espelhou em `publication_items_archive`. A guarda
-- de `move_archived_publication_items_to_cold_storage` faz o que promete e
-- falha alto: "publication_items tem 46 colunas e publication_items_archive
-- tem 45". Medido em 07/09/2026: 344 falhas em 24 h no log do Postgres e
-- 213.778 itens arquivados há mais de 7 dias presos na tabela quente, o mais
-- antigo de 29/08 — cada um deles varrido por todo claim e por todo resumo.
--
-- Adicionar coluna com default constante é só metadado (sem reescrita), e
-- `if not exists` deixa o arquivo idempotente. Aplicada com o PostgREST fora
-- do ar, de propósito: DDL dispara reload do cache de schema, e o mapa de
-- controles (seção 3-D) manda olhar o pool antes de qualquer DDL.
alter table public.publication_items_archive
  add column if not exists infrastructure_retry_count integer not null default 0;
