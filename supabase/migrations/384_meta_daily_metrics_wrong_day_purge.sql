-- Athena Scheduler: apaga a métrica da Meta que foi carimbada no dia errado.
--
-- O ERRO. A Meta agrega insights no fuso da CONTA, e as contas desta frota
-- estão em horário do Pacífico: medido em 05/09/2026, TODO balde volta com
-- `end_time = ...T07:00:00+0000`, que é meia-noite em Los Angeles.
--
-- A coleta pedia a janela do dia de São Paulo (03:00Z → 03:00Z) e carimbava o
-- resultado com a data que havia pedido. Mas a única fatia que cai nessa janela
-- é a que termina às 07:00Z do mesmo dia — e ela cobre das 04:00 de ONTEM às
-- 04:00 de hoje, hora de São Paulo. Todo número entrou **um dia adiantado**:
-- o que a tela chamava de "hoje" era, na verdade, ontem.
--
-- Foi assim que a dashboard passou a mostrar visualizações em "Hoje" a partir
-- das 04h da manhã — não porque o dia corrente tivesse sido liberado, mas
-- porque o balde do dia ANTERIOR fechava naquele instante e era gravado com a
-- data de hoje.
--
-- O QUE MUDOU NO CÓDIGO. `metaBucketLocalDate` passa a ler a data do próprio
-- `end_time`, e a coleta pede a janela alinhada ao balde da conta em vez de ao
-- nosso calendário. Nenhuma adivinhação de fuso: a fronteira vem da API.
--
-- POR QUE APAGAR E NÃO DESLOCAR. Um `metric_date - 1` corrigiria as linhas em
-- bloco e é tentador — 3.121 linhas, todas escritas hoje. Mas ele assume que
-- TODA conta tem a mesma fronteira de 07:00Z, e essa é exatamente a suposição
-- que causou o problema. Apagar e recoletar faz cada conta declarar a própria
-- fronteira. A recoleta leva minutos e cobre os últimos quatro dias.
--
-- Escopo: só `meta_official`, e essa métrica nasceu hoje (linha mais antiga
-- criada em 05/09/2026 03:36 UTC). O histórico da Zernio não é tocado.

with apagadas as (
  delete from public.profile_analytics_daily_metrics
  where provider = 'meta_official'
  returning 1
)
select count(*) as linhas_diarias_apagadas from apagadas;

-- Os snapshots de período seguem a mesma lógica: `period_start`/`period_end`
-- vieram do nosso calendário, então o snapshot "mais recente" de cada perfil
-- aponta para um dia que a Meta não mediu. Eles são reescritos na recoleta.
with apagados as (
  delete from public.profile_analytics_snapshots
  where provider = 'meta_official'
    and created_at >= '2026-09-05T03:00:00Z'
  returning 1
)
select count(*) as snapshots_apagados from apagados;

notify pgrst, 'reload schema';
