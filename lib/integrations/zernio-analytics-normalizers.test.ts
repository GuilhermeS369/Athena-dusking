import assert from 'node:assert/strict';
import test from 'node:test';

import { currentFollowersFromAccount, currentFollowersFromFollowerStats, latestFollowerRow, normalizeFollowerRows } from './zernio-analytics-normalizers.ts';

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

