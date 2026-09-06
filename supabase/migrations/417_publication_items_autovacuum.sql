-- `publication_items` passa a ser aspirada na cadência que o seu uso exige.
--
-- O QUE FOI MEDIDO EM 06/09/2026, e é a coisa mais barata de consertar em todo
-- este incidente. A contagem mais simples possível sobre o conjunto operacional
-- da organização Pomodoro:
--
--   Index Only Scan using publication_items_operational_org_status_idx
--     Heap Fetches: 127.588
--     Buffers: shared hit=124.575
--     Execution Time: 2.469 ms
--
-- Um *index-only scan* que vai ao heap 127 mil vezes não é index-only coisa
-- nenhuma. Ele faz isso quando o MAPA DE VISIBILIDADE está desatualizado: o
-- índice sabe onde as linhas estão, mas não sabe se estão visíveis para a
-- transação, e aí precisa conferir cada uma na tabela.
--
-- POR QUE O MAPA VIVIA DESATUALIZADO. `autovacuum_vacuum_scale_factor` é 0,2 no
-- servidor -- o padrão do Postgres. A tabela tem 1.067.064 linhas vivas, então
-- o autovacuum só é disparado depois de ~213 mil tuplas mortas. Estava em
-- 144.880 (12%) no momento da medição: alto o bastante para arruinar todo
-- index-only scan, baixo o bastante para nunca disparar a limpeza. A tabela
-- recebe ~68 mil publicações por dia, cada uma com várias transições de estado,
-- e cada `update` deixa uma tupla morta.
--
-- O EFEITO DE UM `vacuum (analyze)` MANUAL, medido logo depois:
--
--   Heap Fetches: 400          (de 127.588)
--   Buffers: shared hit=3.281  (de 124.575)
--   Execution Time: 335 ms     (de 2.469 ms)
--
-- 7,4x mais rápido, 38x menos leitura. O vacuum manual foi executado; estas
-- configurações existem para que ele não precise ser executado de novo à mão.
--
-- OS NÚMEROS ESCOLHIDOS, e o raciocínio de cada um:
--
--   vacuum_scale_factor 0,02  -- limpa a ~21 mil tuplas mortas em vez de 213 mil.
--   vacuum_insert_scale_factor 0,02 -- este é o que importa para ESTA tabela e
--       passa despercebido: a programação em massa insere dezenas de milhares de
--       linhas de uma vez, e é o vacuum disparado por INSERÇÃO que marca as
--       páginas novas como visíveis. Sem ele, uma onda de agendamento deixa a
--       fila inteira invisível ao index-only scan até que updates suficientes
--       acumulem.
--   analyze_scale_factor 0,02 -- as estimativas do planejador estavam erradas
--       por quase o dobro (61.824 estimadas contra 105.702 reais), e daí saiu o
--       BitmapAnd que varria 536 mil entradas de índice sem necessidade.
--
-- O CUSTO, dito claramente: o autovacuum vai rodar com muito mais frequência
-- nesta tabela, consumindo I/O em segundo plano. É o troco certo -- o trabalho
-- é o mesmo, feito em porções pequenas e frequentes em vez de raras e enormes,
-- e é exatamente o padrão de uso de uma tabela de fila.
--
-- ISTO NÃO SUBSTITUI a materialização do resumo (418). Aspirar deixa a LEITURA
-- barata; a agregação de 105 mil linhas por requisição continua sendo O(tamanho
-- da fila). As duas coisas são necessárias, e esta é a que também deixa o
-- próprio recálculo do resumo mais barato.

alter table public.publication_items set (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 1000,
  autovacuum_vacuum_insert_scale_factor = 0.02,
  autovacuum_vacuum_insert_threshold = 1000,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_analyze_threshold = 1000
);

-- As mesmas razões valem para as duas outras tabelas quentes da publicação:
-- ambas recebem uma linha por publicação e são lidas por agregação.
alter table public.publication_item_events set (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_vacuum_insert_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.05
);
