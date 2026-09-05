import assert from 'node:assert/strict';
import test from 'node:test';

import {
  META_ACCOUNT_INSIGHT_METRICS,
  classifyMetaAnalyticsFailure,
  metaDailyMetricRow,
  metaDailyRowHasSignal,
  metaBucketLocalDate,
  metaInsightTotals,
  metaInteractions,
  metaNumberValue,
  parseMetaAppUsage,
  saoPauloDay,
  saoPauloDayWindow,
  unsupportedMetricsFromError,
} from './meta-analytics-normalizers.ts';

const profile = { id: 'perfil-1', organization_id: 'org-1' };

test('lê o formato total_value, que é o que a Meta devolve hoje', () => {
  const totals = metaInsightTotals({
    data: [
      { name: 'reach', period: 'day', total_value: { value: 1725 } },
      { name: 'views', period: 'day', total_value: { value: 2857 } },
      { name: 'likes', period: 'day', total_value: { value: 136 } },
    ],
  });
  assert.deepEqual(totals, { reach: 1725, views: 2857, likes: 136 });
});

test('lê também a forma de série temporal, somando a janela', () => {
  // A mesma métrica muda de formato conforme a versão da API e o metric_type.
  // Ler só um dos dois formatos zeraria o perfil sem erro nenhum aparecer.
  const totals = metaInsightTotals({
    data: [{ name: 'reach', period: 'day', values: [{ value: 100, end_time: '2026-09-04T07:00:00+0000' }, { value: 40 }] }],
  });
  assert.deepEqual(totals, { reach: 140 });
});

test('resposta vazia ou inesperada vira objeto vazio, nunca exceção', () => {
  assert.deepEqual(metaInsightTotals(null), {});
  assert.deepEqual(metaInsightTotals({ data: 'nada' }), {});
  assert.deepEqual(metaInsightTotals({ data: [{ total_value: { value: 3 } }] }), {}, 'entrada sem nome não vira métrica');
});

test('interações preferem o número da Meta à soma manual', () => {
  // A Meta conta interações que não estão nas quatro colunas somadas aqui.
  // Preferir a soma faria a dashboard divergir do app do Instagram.
  assert.equal(metaInteractions({ total_interactions: 218, likes: 187, comments: 2, shares: 8, saves: 5 }), 218);
  assert.equal(metaInteractions({ likes: 187, comments: 2, shares: 8, saves: 5, replies: 2 }), 204);
  assert.equal(metaInteractions({}), 0);
});

test('números negativos, texto e ausência viram zero', () => {
  assert.equal(metaNumberValue(-5), 0);
  assert.equal(metaNumberValue('42'), 42);
  assert.equal(metaNumberValue('quarenta'), 0);
  assert.equal(metaNumberValue(undefined), 0);
  assert.equal(metaNumberValue(12.7), 12);
});

test('a linha diária não inventa impressions a partir de views', () => {
  // `impressions` foi aposentada para Instagram e `views` a substituiu. Copiar
  // uma na outra criaria uma métrica que a Meta não mediu.
  const row = metaDailyMetricRow({
    profile,
    metricDate: '2026-09-05',
    totals: { views: 900, reach: 700, likes: 30, total_interactions: 44 },
    posts: 0,
    coverageStatus: 'complete',
  });
  assert.equal(row.impressions, 0);
  assert.equal(row.views, 900);
  assert.equal(row.interactions, 44);
  assert.equal(row.provider, 'meta_official');
  assert.equal(row.metric_date, '2026-09-05');
});

test('dia sem nenhum sinal não vira linha', () => {
  // Gravar zeros faria a tela afirmar "zero visualizações" onde a verdade é
  // "a Meta ainda não consolidou este dia" — foi assim que 944 perfis
  // religados apareceram zerados em 05/09/2026.
  const vazio = metaDailyMetricRow({ profile, metricDate: '2026-09-05', totals: {}, posts: 0, coverageStatus: 'complete' });
  assert.equal(metaDailyRowHasSignal(vazio), false);

  const comDado = metaDailyMetricRow({ profile, metricDate: '2026-09-05', totals: { views: 1 }, posts: 0, coverageStatus: 'complete' });
  assert.equal(metaDailyRowHasSignal(comDado), true);
});

test('métrica recusada é identificada pelo nome e só entre as pedidas', () => {
  const mensagem = '(#100) The following metrics should not be queried with metric_type=total_value: profile_links_taps';
  assert.deepEqual(
    unsupportedMetricsFromError(mensagem, META_ACCOUNT_INSIGHT_METRICS),
    ['profile_links_taps'],
  );
});

test('a lista de valores aceitos na mensagem não derruba as métricas boas', () => {
  // A Meta costuma listar os valores VÁLIDOS na mesma mensagem. Casar com eles
  // removeria justamente o que funciona, e a coleta acabaria sem métrica
  // nenhuma achando que estava se corrigindo.
  const mensagem = "(#100) metric[0] must be one of the following values: reach, views, likes";
  const recusadas = unsupportedMetricsFromError(mensagem, ['reach', 'views', 'likes']);
  assert.equal(recusadas.length, 3, 'sem separador de dois-pontos útil, a decisão fica com quem chamou');
});

test('token vencido é transitório: a renovação existe e é rotina', () => {
  const falha = classifyMetaAnalyticsFailure({ httpStatus: 401, graphCode: 190, message: 'Session has expired' });
  assert.equal(falha.status, 'permission_missing');
  assert.equal(falha.retryable, true, 'marcar como definitivo acenderia alarme em cima de manutenção normal');
});

test('limite de cota e erro de servidor são transitórios; permissão negada não é', () => {
  assert.equal(classifyMetaAnalyticsFailure({ httpStatus: 429, graphCode: 4 }).status, 'rate_limited');
  assert.equal(classifyMetaAnalyticsFailure({ httpStatus: 500 }).retryable, true);
  assert.equal(classifyMetaAnalyticsFailure({ httpStatus: 403, graphCode: 10 }).retryable, false);
});

test('dia fechado pede as 24 horas inteiras', () => {
  const janela = saoPauloDayWindow('2026-09-04', Date.parse('2026-09-05T12:00:00-03:00'));
  assert.equal(janela.since, Math.floor(Date.parse('2026-09-04T00:00:00-03:00') / 1000));
  assert.equal(janela.until - janela.since, 86_400);
});

test('o dia corrente termina AGORA, não à meia-noite que ainda não chegou', () => {
  // Este é o bug que manteve "Hoje" zerado em 05/09/2026: à 01h a coleta pedia
  // 05/09 00:00 → 06/09 00:00, uma janela 22,5 h no futuro, e voltava sem
  // métrica para 1.030 publicações já feitas no dia.
  const agora = Date.parse('2026-09-05T01:30:00-03:00');
  const janela = saoPauloDayWindow('2026-09-05', agora);
  assert.equal(janela.until, Math.floor(agora / 1000));
  assert.ok(janela.until < janela.since + 86_400);
});

test('na virada do dia a janela tem no mínimo uma hora', () => {
  // À 00h05 o intervalo real seria de cinco minutos — janela quase vazia é o
  // mesmo que nenhuma, e a Meta responderia zero por motivo diferente do real.
  const janela = saoPauloDayWindow('2026-09-05', Date.parse('2026-09-05T00:05:00-03:00'));
  assert.equal(janela.until - janela.since, 3_600);
});

test('data inválida falha alto, em vez de coletar o dia errado em silêncio', () => {
  assert.throws(() => saoPauloDayWindow('05/09/2026'), /Data inválida/);
});

test('o dia de São Paulo não escorrega para o seguinte por causa do UTC', () => {
  // 23h em São Paulo já é o dia seguinte em UTC. Usar a data UTC carimbaria a
  // métrica no dia errado toda noite.
  const noite = Date.parse('2026-09-05T23:30:00-03:00');
  assert.equal(saoPauloDay(0, noite), '2026-09-05');
  assert.equal(saoPauloDay(1, noite), '2026-09-04');
});

test('X-App-Usage vira percentual pelo pior dos eixos, nos dois formatos', () => {
  // Formato da Graph API do Facebook.
  assert.equal(parseMetaAppUsage('{"call_count":12,"total_cputime":81,"total_time":30}')?.percent, 81);
  // Formato que `graph.instagram.com` manda de verdade — medido em 05/09/2026.
  // Ler só o formato do Facebook fazia a válvula reportar 0% para sempre.
  assert.equal(parseMetaAppUsage('{"call_volume":0,"cpu_time":0}')?.percent, 0);
  assert.equal(parseMetaAppUsage('{"call_volume":73,"cpu_time":12}')?.percent, 73);
  assert.equal(parseMetaAppUsage(null), null);
  assert.equal(parseMetaAppUsage('não é json'), null);
});

test('a data do balde vem do end_time, não da janela que pedimos', () => {
  // Medido em 05/09/2026: todo balde volta com end_time às 07:00Z, meia-noite
  // no Pacífico. O balde que termina em 05/09 07:00Z cobre das 04:00 de 04/09
  // às 04:00 de 05/09 em São Paulo — é o dia 04/09 da conta, não o 05/09.
  assert.equal(metaBucketLocalDate('2026-09-05T07:00:00+0000'), '2026-09-04');
  assert.equal(metaBucketLocalDate('2026-09-04T07:00:00+0000'), '2026-09-03');
});

test('a data do balde funciona para outros fusos, não só o Pacífico', () => {
  // Conta em São Paulo: meia-noite local às 03:00Z.
  assert.equal(metaBucketLocalDate('2026-09-05T03:00:00+0000'), '2026-09-04');
  // Conta em Tóquio (UTC+9): meia-noite de 05/09 local é 15:00Z de 04/09, e o
  // balde que termina ali cobre o dia 04/09 da conta.
  assert.equal(metaBucketLocalDate('2026-09-04T15:00:00+0000'), '2026-09-04');
  // Conta em UTC.
  assert.equal(metaBucketLocalDate('2026-09-05T00:00:00+0000'), '2026-09-04');
});

test('end_time inválido não vira data inventada', () => {
  assert.equal(metaBucketLocalDate('ontem'), null);
});
