import assert from 'node:assert/strict';
import test from 'node:test';

import { currentFollowersFromAccount, currentFollowersFromFollowerStats, latestFollowerRow, normalizeAnalyticsSourceClasses, normalizeFollowerRows, normalizedDailyMetrics, numberValue, shouldRetryDailyAggregation } from './zernio-analytics-normalizers.ts';

test('normaliza métricas negativas do provedor para zero antes da persistência', () => {
  assert.equal(numberValue(-1), 0);
  assert.equal(numberValue('-27'), 0);
  assert.equal(numberValue(12), 12);
  assert.equal(numberValue('34'), 34);
});

test('mantém classes analíticas canônicas, sem transformar current em sync monolítico', () => {
  assert.deepEqual(normalizeAnalyticsSourceClasses(['current']), ['current']);
  assert.deepEqual(normalizeAnalyticsSourceClasses(['posts', 'current', 'posts']), ['current', 'posts']);
  assert.deepEqual(normalizeAnalyticsSourceClasses(), ['current', 'daily', 'posts']);
});

test('normaliza follower-history documentado pela Zernio e ordena por data', () => {
  const rows = normalizeFollowerRows({
    metrics: {
      follower_count: { values: [{ date: '2026-08-12', value: 120 }, { date: '2026-08-10', value: 100 }] },
      followers_gained: { values: [{ date: '2026-08-12', value: 5 }, { date: '2026-08-10', value: 1 }] },
      followers_lost: { values: [{ date: '2026-08-12', value: 2 }, { date: '2026-08-10', value: 0 }] },
    },
  });

  assert.deepEqual(rows.map((row) => row.snapshot_date), ['2026-08-10', '2026-08-12']);
  assert.equal(latestFollowerRow(rows)?.followers_count, 120);
  assert.equal(rows[1].followers_gained, 5);
  assert.equal(rows[1].followers_lost, 2);
});

test('não assume que o último item bruto é o snapshot mais recente', () => {
  const rows = normalizeFollowerRows({
    history: [
      { snapshot_date: '2026-08-12', followers_count: 240 },
      { snapshot_date: '2026-08-11', followers_count: 230 },
    ],
  });

  assert.equal(latestFollowerRow(rows)?.snapshot_date, '2026-08-12');
  assert.equal(latestFollowerRow(rows)?.followers_count, 240);
});

test('usa total_value como fallback quando a Zernio devolver apenas totais', () => {
  const rows = normalizeFollowerRows({
    dateRange: { since: '2026-08-01', until: '2026-08-12' },
    metricType: 'total_value',
    metrics: {
      follower_count: { total: 345 },
      followers_gained: { total: 12 },
      followers_lost: { total: 3 },
    },
  });

  assert.deepEqual(rows.map(({ snapshot_date, followers_count, followers_gained, followers_lost }) => ({ snapshot_date, followers_count, followers_gained, followers_lost })), [
    { snapshot_date: '2026-08-12', followers_count: 345, followers_gained: 12, followers_lost: 3 },
  ]);
});

test('extrai o total atual de seguidores do payload vivo de accounts', () => {
  assert.equal(currentFollowersFromAccount({ followersCount: 9876 }), 9876);
  assert.equal(currentFollowersFromAccount({ profileData: { follower_count: '5432' } }), 5432);
});

test('extrai o total atual de seguidores do fallback de follower-stats por accountId', () => {
  assert.equal(currentFollowersFromFollowerStats({
    accounts: [
      { accountId: 'outro', followersCount: 10 },
      { accountId: 'principal', followersCount: 777 },
    ],
  }, 'principal'), 777);
});


test('vazio da coleta diária vira nova tentativa quando o perfil publicou na janela', () => {
  // Cenário medido em 30/08/2026: a conta publicou, a Zernio respondeu
  // `dailyData: []` para a chamada que disparou a agregação dela, e minutos
  // depois a mesma chamada devolvia os dias.
  assert.equal(shouldRetryDailyAggregation({
    collectDaily: true,
    payloadReceived: true,
    dailyRowCount: 0,
    expectsDailyMetrics: true,
  }), true);
});

test('perfil sem publicação na janela não entra em loop de tentativa por falta de métrica', () => {
  assert.equal(shouldRetryDailyAggregation({
    collectDaily: true,
    payloadReceived: true,
    dailyRowCount: 0,
    expectsDailyMetrics: false,
  }), false);
});

test('coleta diária com linhas, ciclo sem daily e falha de payload não reagendam', () => {
  assert.equal(shouldRetryDailyAggregation({ collectDaily: true, payloadReceived: true, dailyRowCount: 3, expectsDailyMetrics: true }), false);
  assert.equal(shouldRetryDailyAggregation({ collectDaily: false, payloadReceived: true, dailyRowCount: 0, expectsDailyMetrics: true }), false);
  // Falha de rede já é classificada como fonte parcial e tem retry próprio.
  assert.equal(shouldRetryDailyAggregation({ collectDaily: true, payloadReceived: false, dailyRowCount: 0, expectsDailyMetrics: true }), false);
});

test('normaliza a resposta diária da Zernio em linhas de métrica por dia', () => {
  const rows = normalizedDailyMetrics({
    dailyData: [
      {
        date: '2026-08-29T00:00:00.000Z',
        postCount: 12,
        metrics: { impressions: 505, reach: 301, views: 505, likes: 18, comments: 2, shares: 1, saves: 3 },
      },
      { date: 'invalida', postCount: 9, metrics: { likes: 1 } },
      { date: '2026-08-30', postCount: 14, metrics: { reach: 52, views: 69 } },
    ],
  }, { id: 'perfil-1', organization_id: 'org-1', provider: 'zernio' }, 'complete');

  assert.equal(rows.length, 2, 'linha com data inválida é descartada');
  assert.equal(rows[0].metric_date, '2026-08-29');
  assert.equal(rows[0].posts, 12);
  assert.equal(rows[0].interactions, 24, 'interações somam likes, comentários, shares e saves');
  assert.equal(rows[0].coverage_status, 'complete');
  assert.equal(rows[1].metric_date, '2026-08-30');
  assert.equal(rows[1].likes, 0, 'métrica ausente vira zero, não undefined');
});

test('dia repetido no payload não duplica linha', () => {
  const rows = normalizedDailyMetrics({
    dailyData: [
      { date: '2026-08-30', postCount: 1, metrics: { likes: 1 } },
      { date: '2026-08-30', postCount: 14, metrics: { likes: 9 } },
    ],
  }, { id: 'perfil-1', organization_id: 'org-1', provider: 'zernio' }, 'partial');

  assert.equal(rows.length, 1);
  assert.equal(rows[0].posts, 14, 'a última ocorrência do dia vence');
  assert.equal(rows[0].coverage_status, 'partial');
});

test('payload sem dailyData utilizável devolve lista vazia em vez de quebrar', () => {
  const perfil = { id: 'perfil-1', organization_id: 'org-1', provider: 'zernio' };
  assert.deepEqual(normalizedDailyMetrics(null, perfil, 'complete'), []);
  assert.deepEqual(normalizedDailyMetrics({ dailyData: [] }, perfil, 'complete'), []);
  assert.deepEqual(normalizedDailyMetrics({ dailyData: 'nao-e-array' }, perfil, 'complete'), []);
});
