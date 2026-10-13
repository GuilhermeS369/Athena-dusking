-- Remove seis índices que nunca foram usados (idx_scan = 0 desde a criação do
-- projeto em 07/09/2026, 36 dias de produção) nas tabelas que mais recebem escrita.
-- Decisão do dono em 13/10/2026, para aliviar o banco antes de reduzir o plano.
--
-- Todo insert, update e delete paga a manutenção de cada índice da tabela, usado ou
-- não. publication_items tinha 36 índices (1,7 GB de índice para 234 MB de dados) e
-- 25,2 milhões de escritas no período.
--
--   índice                                               tamanho  escritas na tabela
--   publication_item_events_org_created_idx               108 MB   16,5 milhões
--   profile_post_analytics_snapshots_zernio_post_idx       91 MB   11,4 milhões
--   publication_items_active_profile_schedule_idx          34 MB   25,2 milhões
--   publication_items_zernio_pending_window_idx            32 MB   25,2 milhões
--   publication_items_zernio_ready_window_idx              11 MB   25,2 milhões
--   publication_items_active_slot_lookup_idx                1 MB   25,2 milhões
--
-- Critério: não é chave primária, não é único, não sustenta constraint, não é de
-- partição, e nunca foi lido — nem por consulta, nem por conferência de FK (que
-- também conta em idx_scan). O `zernio_post_idx` é cópia parcial do
-- `zernio_unique_idx` (mesmas colunas), que continua. Os dois `zernio_*_window`
-- serviam à janela da Zernio, provedor abandonado. Os dois `active_*` são variações
-- de `publication_items_active_profile_execute_at_lookup_idx` e de
-- `publication_items_active_format_slot_lookup_idx`, que são os usados.
--
-- Ficaram de propósito, apesar de também nunca usados: os índices de retenção por
-- data (`*_retention_time_idx`, `*_reconciled_time_idx`), porque a rotina de
-- retenção que os usaria pode simplesmente ainda não ter rodado; e os das tabelas
-- quase sem escrita, onde remover não alivia nada.
--
-- Em produção foram removidos com `drop index concurrently` (fora de transação,
-- sem trava exclusiva na tabela) em 13/10/2026; aqui o `if exists` torna a
-- migration inofensiva onde eles já saíram. Para recriar qualquer um, a definição
-- está na migration que o criou.

drop index if exists public.publication_item_events_org_created_idx;
drop index if exists public.profile_post_analytics_snapshots_zernio_post_idx;
drop index if exists public.publication_items_active_profile_schedule_idx;
drop index if exists public.publication_items_zernio_pending_window_idx;
drop index if exists public.publication_items_zernio_ready_window_idx;
drop index if exists public.publication_items_active_slot_lookup_idx;
