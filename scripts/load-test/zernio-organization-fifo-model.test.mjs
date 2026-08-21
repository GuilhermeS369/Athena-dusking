import assert from 'node:assert/strict';
import test from 'node:test';

function drainOrganizationFifo(items) {
  const pending = [...items].sort((a, b) => a.sequence - b.sequence);
  const completed = [];
  let maximumActive = 0;
  while (pending.length) {
    const active = pending.splice(0, 1);
    maximumActive = Math.max(maximumActive, active.length);
    completed.push(...active);
  }
  return { completed, maximumActive };
}

test('500 celulares preservam FIFO e somente um OAuth ativo na organização', () => {
  const items = Array.from({ length: 500 }, (_, sequence) => ({ id: `phone-${sequence}`, sequence }));
  const result = drainOrganizationFifo(items);
  assert.equal(result.completed.length, 500);
  assert.equal(result.maximumActive, 1);
  assert.deepEqual(result.completed.map((item) => item.sequence), items.map((item) => item.sequence));
});

test('organizações diferentes mantêm filas independentes', () => {
  const first = drainOrganizationFifo(Array.from({ length: 250 }, (_, sequence) => ({ sequence })));
  const second = drainOrganizationFifo(Array.from({ length: 250 }, (_, sequence) => ({ sequence })));
  assert.equal(first.maximumActive, 1);
  assert.equal(second.maximumActive, 1);
  assert.equal(first.completed.length + second.completed.length, 500);
});
