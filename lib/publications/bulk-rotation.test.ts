import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRotationResumePlan,
  bulkRotationExecuteAt,
  bulkRotationExpectedPublications,
  bulkRotationLastExecuteAt,
  bulkRotationMediaIndex,
  bulkRotationProfileOffset,
  bulkRotationProfileStep,
  bulkRotationSlotCount,
  makeCompactBulkRotationPlan,
  resolveProfileScheduleBase,
  resumedBulkRotationExecuteAt,
  resumedBulkRotationOriginalSlotIndex,
} from './bulk-rotation.ts';

test('calcula slots de janelas moveis de 24 horas sem ultrapassar a duracao', () => {
  assert.equal(bulkRotationSlotCount(1, 60), BigInt(24));
  assert.equal(bulkRotationSlotCount(3, 60), BigInt(72));
  assert.equal(bulkRotationSlotCount(1, 90), BigInt(16));
  assert.equal(bulkRotationSlotCount(1, 100), BigInt(14));
});

test('comeca em base mais intervalo e calcula o ultimo slot', () => {
  const base = '2026-08-13T17:37:00.000Z';

  assert.equal(bulkRotationExecuteAt(base, 60, 0), '2026-08-13T18:37:00.000Z');
  assert.equal(bulkRotationExecuteAt(base, 60, 23), '2026-08-14T17:37:00.000Z');
  assert.equal(bulkRotationLastExecuteAt(base, 60, 24), '2026-08-14T17:37:00.000Z');
  assert.equal(bulkRotationLastExecuteAt(base, 60, 0), null);
});

test('usa como base o maior valor entre agora, fila ativa e reserva compacta', () => {
  assert.equal(resolveProfileScheduleBase({
    now: '2026-08-13T17:00:00.000Z',
    lastActiveExecuteAt: '2026-08-15T17:00:00.000Z',
    lastReservedExecuteAt: '2026-08-14T17:00:00.000Z',
  }), '2026-08-15T17:00:00.000Z');

  assert.equal(resolveProfileScheduleBase({
    now: '2026-08-13T17:00:00.000Z',
  }), '2026-08-13T17:00:00.000Z');
});

test('forma plano minimo para um perfil sem fila e uma midia', () => {
  const plan = makeCompactBulkRotationPlan({
    format: 'image',
    intervalMinutes: 1_440,
    durationDays: 1,
    orderMode: 'same_order',
    rotationSeed: 'plano-minimo',
    profileCount: 1,
    mediaCount: 1,
  });

  assert.equal(plan.profileCount, BigInt(1));
  assert.equal(plan.mediaCount, BigInt(1));
  assert.equal(plan.slotsPerProfile, BigInt(1));
  assert.equal(plan.expectedPublications, BigInt(1));
  assert.equal(bulkRotationMediaIndex({ slotIndex: 0, mediaCount: 1 }), 0);
});

test('projeta volumes acima do limite antigo usando bigint', () => {
  assert.equal(bulkRotationExpectedPublications(500, 72), BigInt(36_000));
  assert.equal(bulkRotationExpectedPublications('5000000000', '1000000000'), BigInt('5000000000000000000'));

  const plan = makeCompactBulkRotationPlan({
    format: 'reel',
    intervalMinutes: 60,
    durationDays: 365,
    orderMode: 'diversified',
    rotationSeed: 'lote-estavel',
    profileCount: 500,
    mediaCount: 40,
  });

  assert.equal(plan.slotsPerProfile, BigInt(8_760));
  assert.equal(plan.expectedPublications, BigInt(4_380_000));
  assert.equal(plan.version, 2);
});

test('repete 20 midias continuamente em 24 slots e continua na midia 5', () => {
  const firstDay = Array.from({ length: 24 }, (_, index) => bulkRotationMediaIndex({
    slotIndex: index,
    mediaCount: 20,
  }));

  assert.deepEqual(firstDay, [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    0, 1, 2, 3,
  ]);
  assert.equal(bulkRotationMediaIndex({ slotIndex: 24, mediaCount: 20 }), 4);
});

test('mesma ordem sempre inicia todos os perfis na primeira midia', () => {
  for (let profileOrdinal = 0; profileOrdinal < 500; profileOrdinal += 1) {
    assert.equal(bulkRotationProfileOffset({
      orderMode: 'same_order',
      profileOrdinal,
      mediaCount: 40,
      rotationSeed: 'ignorada-neste-modo',
    }), 0);
  }
});

test('rotacao diversificada distribui 300 perfis de forma equilibrada em 40 posicoes', () => {
  const counts = new Array<number>(40).fill(0);
  for (let profileOrdinal = 0; profileOrdinal < 300; profileOrdinal += 1) {
    const offset = bulkRotationProfileOffset({
      orderMode: 'diversified',
      profileOrdinal,
      mediaCount: 40,
      rotationSeed: 'lote-300',
    });
    counts[offset] += 1;
  }

  assert.equal(Math.max(...counts) - Math.min(...counts), 1);
  assert.equal(counts.reduce((sum, count) => sum + count, 0), 300);
});

test('rotacao diversificada distribui 500 perfis e permanece deterministica', () => {
  const offsetsA = Array.from({ length: 500 }, (_, profileOrdinal) => bulkRotationProfileOffset({
    orderMode: 'diversified',
    profileOrdinal,
    mediaCount: 40,
    rotationSeed: 'lote-500',
  }));
  const offsetsB = Array.from({ length: 500 }, (_, profileOrdinal) => bulkRotationProfileOffset({
    orderMode: 'diversified',
    profileOrdinal,
    mediaCount: 40,
    rotationSeed: 'lote-500',
  }));
  const counts = offsetsA.reduce<number[]>((result, offset) => {
    result[offset] += 1;
    return result;
  }, new Array<number>(40).fill(0));

  assert.deepEqual(offsetsA, offsetsB);
  assert.equal(Math.max(...counts) - Math.min(...counts), 1);
});

test('cada perfil diversificado percorre todas as midias uma vez por ciclo', () => {
  const offset = bulkRotationProfileOffset({
    orderMode: 'diversified',
    profileOrdinal: 287,
    mediaCount: 40,
    rotationSeed: 'ciclo-completo',
  });
  const step = bulkRotationProfileStep({
    orderMode: 'diversified',
    profileOrdinal: 287,
    mediaCount: 40,
    rotationSeed: 'ciclo-completo',
  });
  const cycle = Array.from({ length: 40 }, (_, slotIndex) => bulkRotationMediaIndex({
    slotIndex,
    profileOffset: offset,
    profileStep: step,
    mediaCount: 40,
  }));

  assert.deepEqual([...new Set(cycle)].sort((left, right) => left - right), Array.from({ length: 40 }, (_, index) => index));
});

test('versao 2 evita que perfis vizinhos sejam apenas copias deslocadas', () => {
  const sequenceFor = (profileOrdinal: number) => {
    const common = { orderMode: 'diversified' as const, profileOrdinal, mediaCount: 159, rotationSeed: 'lote-diversidade-forte' };
    const profileOffset = bulkRotationProfileOffset(common);
    const profileStep = bulkRotationProfileStep(common);
    return Array.from({ length: 90 }, (_, slotIndex) => bulkRotationMediaIndex({ slotIndex, profileOffset, profileStep, mediaCount: 159 }));
  };
  const first = sequenceFor(65);
  const second = sequenceFor(66);
  const shiftedEquality = first.slice(0, -1).filter((media, index) => media === second[index + 1]).length;
  const sharedMedia = new Set(first.filter((media) => new Set(second).has(media))).size;

  assert.ok(shiftedEquality < 10, `sequências ainda parecem deslocadas: ${shiftedEquality}/89`);
  assert.ok(sharedMedia < 70, `sobreposição excessiva no horizonte parcial: ${sharedMedia}/90`);
});

test('versao 1 permanece reproduzindo a rotacao legada', () => {
  const firstOffset = bulkRotationProfileOffset({ orderMode: 'diversified', profileOrdinal: 65, mediaCount: 159, rotationSeed: 'legado', algorithmVersion: 1 });
  const secondOffset = bulkRotationProfileOffset({ orderMode: 'diversified', profileOrdinal: 66, mediaCount: 159, rotationSeed: 'legado', algorithmVersion: 1 });
  assert.equal(secondOffset, (firstOffset + 1) % 159);
  assert.equal(bulkRotationProfileStep({ orderMode: 'diversified', profileOrdinal: 66, mediaCount: 159, rotationSeed: 'legado', algorithmVersion: 1 }), 1);
});

test('retomada ignora slots vencidos e redistribui somente os futuros depois da nova base', () => {
  const resume = buildRotationResumePlan({
    now: '2026-08-13T15:30:00.000Z',
    intervalMinutes: 60,
    originalBaseAt: '2026-08-13T10:00:00.000Z',
    totalSlotCount: 10,
    nextPendingSlotIndex: 2,
    lastCompetingActiveExecuteAt: '2026-08-13T18:00:00.000Z',
  });

  assert.equal(resume.ignoredSlotCount, BigInt(3));
  assert.equal(resume.ignoredFromSlotIndex, BigInt(2));
  assert.equal(resume.ignoredThroughSlotIndex, BigInt(4));
  assert.equal(resume.nextPreservedSlotIndex, BigInt(5));
  assert.equal(resume.remainingSlotCount, BigInt(5));
  assert.equal(resume.resumedBaseAt, '2026-08-13T18:00:00.000Z');
  assert.equal(resume.firstResumedExecuteAt, '2026-08-13T19:00:00.000Z');
  assert.equal(resume.lastResumedExecuteAt, '2026-08-13T23:00:00.000Z');
  assert.equal(resumedBulkRotationOriginalSlotIndex(resume, 0), BigInt(5));
  assert.equal(resumedBulkRotationOriginalSlotIndex(resume, 4), BigInt(9));
  assert.equal(resumedBulkRotationExecuteAt(resume, 60, 1), '2026-08-13T20:00:00.000Z');
});

test('retomada nao inventa slots quando todos os pendentes venceram', () => {
  const resume = buildRotationResumePlan({
    now: '2026-08-14T10:00:00.000Z',
    intervalMinutes: 60,
    originalBaseAt: '2026-08-13T10:00:00.000Z',
    totalSlotCount: 5,
    nextPendingSlotIndex: 1,
  });

  assert.equal(resume.ignoredSlotCount, BigInt(4));
  assert.equal(resume.remainingSlotCount, BigInt(0));
  assert.equal(resume.firstResumedExecuteAt, null);
  assert.equal(resume.lastResumedExecuteAt, null);
});

test('rejeita configuracoes que nao podem formar um plano valido', () => {
  assert.throws(() => bulkRotationSlotCount(0, 60), /durationDays/);
  assert.throws(() => bulkRotationSlotCount(1, 0), /intervalMinutes/);
  assert.throws(() => bulkRotationMediaIndex({ slotIndex: 0, mediaCount: 0 }), /mediaCount/);
  assert.throws(() => makeCompactBulkRotationPlan({
    format: 'story',
    intervalMinutes: 60,
    durationDays: 1,
    orderMode: 'same_order',
    rotationSeed: 'sem-midia',
    profileCount: 1,
    mediaCount: 0,
  }), /mediaCount/);
  assert.throws(() => makeCompactBulkRotationPlan({
    format: 'reel',
    intervalMinutes: 2_000,
    durationDays: 1,
    orderMode: 'same_order',
    rotationSeed: 'lote',
    profileCount: 1,
    mediaCount: 1,
  }), /não produzem nenhum slot/);
});
