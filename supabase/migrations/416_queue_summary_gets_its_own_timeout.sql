-- A fila deixa de falhar enquanto o conserto estrutural não vem: a função ganha
-- limite de tempo próprio.
--
-- ISTO É UM PALIATIVO, E ESTÁ ESCRITO ASSIM DE PROPÓSITO. Não torna nada mais
-- rápido; só para de transformar uma consulta lenta em tela quebrada.
--
-- O QUE JÁ FOI TIRADO, e por que não bastou. Três migrations atacaram o custo
-- desta função em 06/09/2026, cada uma com ganho real e medido:
--
--   412  projeção de 7 colunas no lugar de `item.*`
--   414  fim da contagem de 450 mil arquivados (3.050 ms) que a tela não lia,
--        e fim do join de reconhecimentos que só 48 das 86.487 linhas usavam
--   415  um agrupamento por perfil no lugar de tres `count(distinct)`
--
-- Resultado: a aba de contas recortada por grupo saiu de estouro para 6.098 ms.
-- Os agrupamentos completos seguem em 57014 (grupo 8.733 ms, lote 8.240 ms).
--
-- POR QUE PAROU DE MELHORAR. O piso não está nos agregados, está na leitura.
-- Uma contagem crua das 86.487 linhas não arquivadas -- a consulta mais simples
-- possível sobre esse mesmo conjunto -- custa 2.766 ms. A tabela tem 536 mil
-- linhas, recebe ~68 mil escritas por dia, e o conjunto operacional cresceu
-- porque a fila hoje guarda 86 mil publicações AGENDADAS, não uma dúzia de
-- publicações vivas. Nenhuma reescrita da consulta muda esse piso.
--
-- O QUE RESOLVE DE VERDADE, e que esta migration não faz: manter os totais
-- incrementalmente (tabela de contadores por organização, atualizada por
-- gatilho ou pelo worker) em vez de recontar 86 mil linhas a cada leitura. É
-- obra maior, e precisa de decisão sobre consistência: contador incremental
-- pode divergir, e aí precisa de uma reconciliação periódica.
--
-- O NÚMERO. 25 s cobre com folga os ~9 s observados e ainda é um teto -- uma
-- consulta patológica continua sendo cortada, em vez de segurar conexão
-- indefinidamente. O `set` vale só para esta função: sai do escopo quando ela
-- retorna, e nenhuma outra consulta da aplicação herda o limite maior.
--
-- A TELA PRECISA ACOMPANHAR. O polling do resumo é de 1x/minuto por aba aberta
-- (SUMMARY_POLL_INTERVAL_MS), e a aba "Por conta" -- a mais cara, por agregar
-- uma linha por perfil -- só consulta quando o operador escolhe um grupo e
-- clica em buscar (413). Sem essas duas coisas, um limite maior viraria licença
-- para a tela pendurar o banco.

alter function public.get_publication_queue_reference_page(uuid, text, integer, integer, integer, uuid)
  set statement_timeout = '25s';

notify pgrst, 'reload schema';
