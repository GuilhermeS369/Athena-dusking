import assert from 'node:assert/strict';
import test from 'node:test';

import { createAdaptiveBulkController } from './adaptive-bulk-controller.mjs';

test('controlador adaptativo começa em 50, reduz para 25 e sobe para 100 após estabilidade', () => {
  const controller = createAdaptiveBulkController({ initialStep: 50, minimumStep: 25, maximumStep: 100, random: () => 0 });
  assert.equal(controller.snapshot(0).currentStep, 50);

  controller.observe({ durationMs: 751, ok: true, now: 1000 });
  assert.equal(controller.snapshot(1000).currentStep, 25);
  assert.equal(controller.snapshot(1000).lastReason, 'slow_database_slice');

  for (let index = 0; index < 5; index += 1) {
    controller.observe({ durationMs: 100, ok: true, now: 3000 + index * 1000 });
  }
  assert.equal(controller.snapshot(7000).currentStep, 50);

  for (let index = 0; index < 5; index += 1) {
    controller.observe({ durationMs: 100, ok: true, now: 8000 + index * 1000 });
  }
  assert.equal(controller.snapshot(12000).currentStep, 100);
});

test('controlador usa custo por item para subir mesmo quando a chamada passa de 750 ms', () => {
  const controller = createAdaptiveBulkController({
    initialStep: 25,
    minimumStep: 25,
    maximumStep: 100,
    fastPerItemThresholdMs: 25,
    stableSlicesRequired: 5,
    random: () => 0,
  });

  for (let index = 0; index < 5; index += 1) {
    controller.observe({ durationMs: 1000, processedItems: 50, ok: true, now: 1000 + index * 3000 });
  }
  let state = controller.snapshot(13000);
  assert.equal(state.currentStep, 50);
  assert.equal(state.lastDurationPerItemMs, 20);

  for (let index = 0; index < 5; index += 1) {
    controller.observe({ durationMs: 2000, processedItems: 100, ok: true, now: 16000 + index * 5000 });
  }
  state = controller.snapshot(36000);
  assert.equal(state.currentStep, 100);
  assert.equal(state.lastReason, 'stable_raise_to_maximum');
});

test('controlador reduz quando chamada é lenta e ineficiente por item', () => {
  const controller = createAdaptiveBulkController({ initialStep: 100, minimumStep: 25, maximumStep: 100 });
  const state = controller.observe({ durationMs: 1250, processedItems: 25, ok: true, now: 1000 });
  assert.equal(state.currentStep, 25);
  assert.equal(state.lastDurationPerItemMs, 50);
  assert.equal(state.lastReason, 'slow_database_slice');
});

test('controlador pausa 120 segundos após statement timeout', () => {
  const controller = createAdaptiveBulkController({ initialStep: 50, timeoutCooldownMs: 120000 });
  const state = controller.observe({ durationMs: 30000, ok: false, message: 'canceling statement due to statement timeout', now: 1000 });
  assert.equal(state.currentStep, 25);
  assert.equal(state.lastReason, 'database_timeout');
  assert.equal(state.remainingCooldownMs, 120000);
  assert.equal(controller.canRun(120999), false);
  assert.equal(controller.canRun(121000), true);
});

test('atraso crítico reduz para 25 e aplica cooldown protegido', () => {
  const controller = createAdaptiveBulkController({ initialStep: 100, random: () => 0.5 });
  const state = controller.markCriticalDelay(1000);
  assert.equal(state.currentStep, 25);
  assert.equal(state.lastReason, 'critical_publication_delay');
  assert.equal(state.lastCooldownMs, 10000);
});
