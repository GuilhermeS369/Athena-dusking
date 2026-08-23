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
  const rotation = { orderMode:'diversified' as const, rotationSeed:'campanha-a', profileOrdinal:0 };
  const cycle = Array.from({ length:combinations.length }, (_, slot) => getTwitterCombinationForSlot(combinations, rotation, slot));
  assert.equal(new Set(cycle.map((item) => `${item.textIndex}:${item.mediaSetIndex}`)).size, combinations.length);
  assert.deepEqual(getTwitterCombinationForSlot(combinations, rotation, combinations.length), cycle[0]);
});

test('modo diversificado replica a rotação v2 do Instagram por ordinal de perfil', () => {
  const combinations = buildTwitterCombinations(2, 3);
  assert.notDeepEqual(
    getTwitterCombinationForSlot(combinations, {orderMode:'diversified',rotationSeed:'campanha-a',profileOrdinal:0}, 0),
    getTwitterCombinationForSlot(combinations, {orderMode:'diversified',rotationSeed:'campanha-a',profileOrdinal:1}, 0),
  );
  assert.deepEqual(
    getTwitterCombinationForSlot(combinations, {orderMode:'diversified',rotationSeed:'campanha-a',profileOrdinal:1}, 0),
    getTwitterCombinationForSlot(combinations, {orderMode:'diversified',rotationSeed:'campanha-a',profileOrdinal:1}, combinations.length),
  );
});

test('modo mesma ordem preserva a sequência canônica em todos os perfis', () => {
  const combinations = buildTwitterCombinations(2, 2);
  for (let slot=0;slot<combinations.length;slot+=1) {
    assert.deepEqual(getTwitterCombinationForSlot(combinations,{orderMode:'same_order',rotationSeed:'ignorada',profileOrdinal:0},slot),combinations[slot]);
    assert.deepEqual(getTwitterCombinationForSlot(combinations,{orderMode:'same_order',rotationSeed:'outra',profileOrdinal:9},slot),combinations[slot]);
  }
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
