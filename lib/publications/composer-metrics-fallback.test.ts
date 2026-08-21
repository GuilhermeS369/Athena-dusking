import assert from 'node:assert/strict';
import test from 'node:test';

import { composerMetricsFromItems } from './composer-metrics-fallback.ts';

test('mantém contagens futuras e publicadas quando o RPC do compositor falha', () => {
  const now = Date.parse('2026-08-19T00:00:00.000Z');
  const [metric] = composerMetricsFromItems([{ id: 'perfil-1' }], [
    { profile_id: 'perfil-1', format: 'reel', status: 'waiting', execute_at: '2026-08-19T01:00:00.000Z' },
    { profile_id: 'perfil-1', format: 'story', status: 'ready', execute_at: '2026-08-20T01:00:00.000Z' },
    { profile_id: 'perfil-1', format: 'reel', status: 'published', execute_at: '2026-08-18T01:00:00.000Z' },
    { profile_id: 'perfil-1', format: 'story', status: 'waiting', execute_at: '2026-08-18T23:59:59.000Z' },
  ], now);

  assert.deepEqual(metric.scheduled_counts, { reel: 1, story: 1, image: 0, carousel: 0, total: 2 });
  assert.deepEqual(metric.published_counts, { reel: 1, story: 0, image: 0, carousel: 0, total: 1 });
  assert.equal(metric.scheduled_post_count, 2);
  assert.deepEqual(metric.scheduled_execute_ats_by_format.reel, ['2026-08-19T01:00:00.000Z']);
  assert.deepEqual(metric.scheduled_execute_ats_by_format.story, ['2026-08-20T01:00:00.000Z']);
});
