import assert from 'node:assert/strict';
import test from 'node:test';

import {
  allocateTwitterFundingRoundRobin,
  buildTwitterCombinations,
  getTwitterCombinationForSlot,
} from './bulk.ts';

test('usa todas as combinações texto por mídia antes de repetir', () => {
  const combinations = buildTwitterCombinations(2, 3);
  assert.equal(combinations.length, 6);
  assert.deepEqual(new Set(combinations.map((item) => `${item.textIndex}:${item.mediaSetIndex}`)).size, 6);
  assert.deepEqual(getTwitterCombinationForSlot(combinations, 0, 6), combinations[0]);
});

test('perfis começam em deslocamentos determinísticos diferentes', () => {
  const combinations = buildTwitterCombinations(2, 2);
  assert.notDeepEqual(
    getTwitterCombinationForSlot(combinations, 0, 0),
    getTwitterCombinationForSlot(combinations, 1, 0),
  );
  assert.deepEqual(
    getTwitterCombinationForSlot(combinations, 1, 0),
    getTwitterCombinationForSlot(combinations, 1, 4),
  );
});

test('round-robin é justo e pula URL cara procurando slots baratos', () => {
  const result = allocateTwitterFundingRoundRobin([
    { id: 'a-url', profileId: 'a', scheduledAt: '2026-08-23T10:00:00Z', amountMicros: 200_000 },
    { id: 'a-cheap', profileId: 'a', scheduledAt: '2026-08-23T11:00:00Z', amountMicros: 15_000 },
    { id: 'b-cheap', profileId: 'b', scheduledAt: '2026-08-23T10:00:00Z', amountMicros: 15_000 },
  ], 30_000);
  assert.deepEqual(result.funded.map((item) => item.id), ['a-cheap', 'b-cheap']);
  assert.deepEqual(result.unfunded.map((item) => item.id), ['a-url']);
  assert.equal(result.remainingMicros, 0);
});
