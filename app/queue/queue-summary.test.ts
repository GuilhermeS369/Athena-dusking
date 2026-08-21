import assert from 'node:assert/strict';
import test from 'node:test';

import { operationalQueueMetric } from './queue-summary.ts';

test('não inclui reels cancelados no total operacional do cartão de grupo', () => {
  assert.deepEqual(operationalQueueMetric([
    { status: 'published' },
    { status: 'waiting' },
    { status: 'cancelled' },
    { status: 'cancelled' },
    { status: 'removed' },
  ]), {
    total: 2,
    completed: 1,
    active: 1,
    closed: 3,
    progress: 50,
  });
});
