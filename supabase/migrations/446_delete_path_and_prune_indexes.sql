-- Quatro índices que faltavam, achados na varredura de 13/10/2026 (pg_stat_user_tables
-- e EXPLAIN ANALYZE de um DELETE em publication_items, em transação desfeita).
--
-- Os três primeiros são FKs `on delete set null` para publication_items sem índice na
-- coluna: cada item apagado (arquivo frio, limpeza, exclusão de mídia) varria a
-- tabela filha inteira. São tabelas pequenas, então cada varredura é barata, mas
-- eram ~3,29 milhões de varreduras em 36 dias em cada uma:
--
--   meta_profile_disconnection_incidents    3.295.521 varreduras, 14,0 bilhões de linhas lidas
--   zernio_profile_disconnection_incidents  3.287.749 varreduras,  6,4 bilhões
--   publication_batch_circuit_breakers      3.287.748 varreduras,  1,6 bilhão
--
-- No DELETE medido eram, juntas, 2,3 ms por item apagado (115 ms em 50 itens), o
-- que sobrou de mais caro depois do índice da 445.
--
-- O quarto serve à poda diária de profile_post_analytics_snapshots
-- (prune_profile_post_analytics: `where published_at < corte order by published_at
-- limit n`). Sem índice em published_at a poda varria a tabela de 940 MB a cada
-- chamada: 9.111 varreduras e 5,0 bilhões de linhas lidas em 36 dias.
--
-- Criação comum, não `concurrently`: três tabelas têm menos de 10 mil linhas e a
-- quarta foi construída em menos de 2 s no ensaio.

create index if not exists meta_profile_disconnection_incidents_source_item_idx
  on public.meta_profile_disconnection_incidents (source_item_id);

create index if not exists zernio_profile_disconnection_incidents_source_item_idx
  on public.zernio_profile_disconnection_incidents (source_item_id);

create index if not exists publication_batch_circuit_breakers_last_failure_item_idx
  on public.publication_batch_circuit_breakers (last_failure_item_id);

create index if not exists profile_post_analytics_snapshots_published_at_idx
  on public.profile_post_analytics_snapshots (published_at)
  where published_at is not null;
