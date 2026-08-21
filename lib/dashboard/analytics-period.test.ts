import assert from 'node:assert/strict';
import test from 'node:test';

import { dashboardPeriodRange, dailyMetricRanking, filterDailyMetricsForPeriod, sumDailyMetrics, type DashboardDailyMetric } from './analytics-period.ts';

const rows: DashboardDailyMetric[] = [
  { profile_id: 'a', date: '2026-08-15', posts: 2, impressions: 100, reach: 55, views: 70, likes: 8, comments: 1, shares: 1, saves: 0, interactions: 10 },
  { profile_id: 'a', date: '2026-08-16', posts: 3, impressions: 200, reach: 120, views: 150, likes: 15, comments: 2, shares: 2, saves: 1, interactions: 20 },
  { profile_id: 'b', date: '2026-08-16', posts: 1, impressions: 50, reach: 25, views: 30, likes: 3, comments: 1, shares: 0, saves: 0, interactions: 4 },
];

test('Hoje soma apenas a data de hoje', () => {
  const filtered = filterDailyMetricsForPeriod(rows, new Set(['a', 'b']), { startDate: '2026-08-16', endDate: '2026-08-16', startIso: '', endIso: '' });
  assert.deepEqual(sumDailyMetrics(filtered), { posts: 4, impressions: 250, reach: 145, views: 180, likes: 18, comments: 3, shares: 2, saves: 1, interactions: 24 });
});

test('Ontem não reutiliza métricas de hoje', () => {
  const filtered = filterDailyMetricsForPeriod(rows, new Set(['a', 'b']), { startDate: '2026-08-15', endDate: '2026-08-15', startIso: '', endIso: '' });
  assert.equal(sumDailyMetrics(filtered).reach, 55);
});

test('Últimos dias agregam as linhas diárias e respeitam o perfil', () => {
  const filtered = filterDailyMetricsForPeriod(rows, new Set(['a']), { startDate: '2026-08-10', endDate: '2026-08-16', startIso: '', endIso: '' });
  assert.equal(sumDailyMetrics(filtered).reach, 175);
  assert.equal(dailyMetricRanking(filtered, ['a'], 'likes').get('a'), 23);
});

test('Períodos usam a data civil de São Paulo, mesmo na virada UTC', () => {
  const range = dashboardPeriodRange('1', new Date('2026-08-18T00:30:00.000Z'));
  assert.deepEqual(range, {
    startDate: '2026-08-17',
    endDate: '2026-08-17',
    startIso: '2026-08-17T00:00:00-03:00',
    endIso: '2026-08-17T23:59:59.999-03:00',
  });
});

test('Ontem e anteontem mantêm janelas de um único dia', () => {
  assert.equal(dashboardPeriodRange('2', new Date('2026-08-18T12:00:00.000Z')).startDate, '2026-08-17');
  assert.equal(dashboardPeriodRange('3', new Date('2026-08-18T12:00:00.000Z')).startDate, '2026-08-16');
});
