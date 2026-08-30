-- Índices nas chaves estrangeiras que apontam para publication_items sem
-- suporte de índice.
--
-- SINTOMA QUE LEVOU AO ACHADO (30/08/2026): a primeira execução do arquivo frio
-- (migration 333) morreu com `canceling statement due to statement timeout` ao
-- tentar mover 500 itens.
--
-- CAUSA: apagar uma linha de `publication_items` obriga o Postgres a resolver
-- cada chave estrangeira que aponta para ela. Sem índice na coluna que
-- referencia, isso é uma varredura completa da tabela referenciadora **por linha
-- apagada**. Duas tabelas grandes estavam nessa situação:
--
--   instagram_observability_events.item_id          613.611 linhas
--   profile_post_analytics_snapshots.publication_item_id  150.352 linhas
--
-- Ou seja, ~764 mil linhas varridas para apagar UMA publicação.
--
-- O EFEITO É MAIOR QUE O ARQUIVO FRIO: apagar qualquer item de publicação era
-- lento por este motivo, em qualquer caminho do sistema. O arquivo frio só foi
-- o primeiro a bater no teto de tempo e tornar o problema visível.
--
-- Índices PARCIAIS porque as duas colunas são anuláveis (`on delete set null`) e
-- boa parte das linhas não referencia item nenhum. O Postgres usa índice parcial
-- em `coluna = $1` normalmente, porque a igualdade já implica `is not null`.
--
-- As demais chaves estrangeiras para publication_items foram conferidas: ou já
-- têm índice (chave primária, única, ou índice próprio), ou estão em tabelas com
-- menos de 5 mil linhas, onde a varredura é irrelevante.

create index if not exists instagram_observability_events_item_idx
  on public.instagram_observability_events (item_id)
  where item_id is not null;

create index if not exists profile_post_analytics_snapshots_item_idx
  on public.profile_post_analytics_snapshots (publication_item_id)
  where publication_item_id is not null;

create index if not exists zernio_publication_request_anomalies_item_idx
  on public.zernio_publication_request_anomalies (publication_item_id)
  where publication_item_id is not null;

comment on index public.instagram_observability_events_item_idx is
  'Sustenta o ON DELETE SET NULL vindo de publication_items. Sem ele, apagar uma publicação varre as 613 mil linhas desta tabela.';
comment on index public.profile_post_analytics_snapshots_item_idx is
  'Sustenta o ON DELETE SET NULL vindo de publication_items. Sem ele, apagar uma publicação varre as 150 mil linhas desta tabela.';
