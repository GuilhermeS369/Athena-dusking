-- Índice que faltava na FK publication_batch_terminal_outcomes.event_id.
--
-- Cada linha apagada de publication_item_events dispara a conferência desta FK
-- (on delete cascade), e sem índice ela varre a tabela inteira: 49 MB e 239 mil
-- linhas por evento. Medido em 13/10/2026 com EXPLAIN ANALYZE em transação
-- desfeita, apagando itens de publication_items (2 a 3 eventos por item):
--
--   sem o índice: 28 ms por evento  -> 59 ms por item ignorado, 97 ms por publicado
--   com o índice: 0,02 ms por evento ->  5 ms por item ignorado,  7 ms por publicado
--
-- 93 % do custo de apagar um item da fila era esta varredura. Ela pesa em todo
-- caminho que apaga item: o arquivo frio (move_archived_publication_items_to_
-- cold_storage, ~40 mil itens por dia = dezenas de minutos de banco por dia) e a
-- limpeza do histórico do modo antigo pedida pelo dono no mesmo dia.
--
-- Criação comum, não `concurrently`: a tabela é pequena (construído em 214 ms no
-- ensaio) e a trava de escrita dura só esse tempo.

create index if not exists publication_batch_terminal_outcomes_event_id_idx
  on public.publication_batch_terminal_outcomes (event_id);
