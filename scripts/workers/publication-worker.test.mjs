import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSingleFlightGuard,
  dispatchHasOperationalActivity,
  fairDispatchOrder,
  selectWithinOrganizationDispatchWindow,
  stagingHasSafeWindow,
} from './publication-worker.mjs';

test('ciclo ocioso não exige evento operacional por polling', () => {
  assert.equal(dispatchHasOperationalActivity({ claimed: 0, processed: [], recycling: [] }), false);
});

test('claim, preparação e recuperação continuam visíveis na telemetria agregada', () => {
  assert.equal(dispatchHasOperationalActivity({ claimed: 1, processed: [] }), true);
  assert.equal(dispatchHasOperationalActivity({ claimed: 0, processed: [], preparation: { claimed: 1 } }), true);
  assert.equal(dispatchHasOperationalActivity({ claimed: 0, processed: [], recovery: { rescheduled: 1 } }), true);
});

test('despacho antecipado alterna organizações sem perder ordem temporal interna', () => {
  const ordered = fairDispatchOrder([
    { itemId: 'a2', organizationId: 'a', profileId: 'p2', executeAt: '2026-08-28T07:00:00Z' },
    { itemId: 'a1', organizationId: 'a', profileId: 'p1', executeAt: '2026-08-28T07:00:00Z' },
    { itemId: 'b1', organizationId: 'b', profileId: 'p1', executeAt: '2026-08-28T07:00:00Z' },
    { itemId: 'b2', organizationId: 'b', profileId: 'p2', executeAt: '2026-08-28T07:00:00Z' },
  ]);
  assert.deepEqual(ordered.map((item) => item.itemId), ['a1', 'b1', 'a2', 'b2']);
});

test('janela local limita cada organização sem impedir outras de avançar', () => {
  const now = Date.parse('2026-08-28T07:30:00Z');
  const history = new Map([['a', [now - 20_000, now - 10_000]]]);
  const result = selectWithinOrganizationDispatchWindow([
    { itemId: 'a1', organizationId: 'a', profileId: 'p1', executeAt: '2026-08-28T07:29:00Z' },
    { itemId: 'b1', organizationId: 'b', profileId: 'p1', executeAt: '2026-08-28T07:29:00Z' },
    { itemId: 'b2', organizationId: 'b', profileId: 'p2', executeAt: '2026-08-28T07:29:00Z' },
  ], history, now, 10, 2);
  assert.deepEqual(result.selected.map((item) => item.itemId), ['b1', 'b2']);
  assert.equal(result.nextHistory.get('a').length, 2);
  assert.equal(result.nextHistory.get('b').length, 2);
});

test('pré-carregamento cede prioridade quando existe publicação dentro da guarda', async () => {
  const calls = [];
  const blocked = await stagingHasSafeWindow({
    async listDue(cutoff, limit) {
      calls.push({ cutoff, limit });
      return [{ itemId: 'due' }];
    },
  }, 1_000_000, 60_000);
  const safe = await stagingHasSafeWindow({ async listDue() { return []; } }, 1_000_000, 60_000);
  assert.equal(blocked, false);
  assert.equal(safe, true);
  assert.deepEqual(calls, [{ cutoff: 1_060_000, limit: 1 }]);
});

test('single-flight guard nunca deixa um ciclo reentrar enquanto o anterior está em voo', async () => {
  const guard = createSingleFlightGuard();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let started = 0;

  const first = guard.run(async () => {
    started += 1;
    await gate;
    return 'primeiro';
  });
  assert.equal(guard.isBusy(), true);

  const second = await guard.run(async () => {
    started += 1;
    return 'segundo';
  });
  assert.deepEqual(second, { skipped: true, value: undefined });
  assert.equal(started, 1, 'a segunda chamada não deveria ter executado a função');

  release();
  const firstResult = await first;
  assert.deepEqual(firstResult, { skipped: false, value: 'primeiro' });
  assert.equal(guard.isBusy(), false);

  const third = await guard.run(async () => 'terceiro');
  assert.deepEqual(third, { skipped: false, value: 'terceiro' });
});

test('loop de dispatch continua avançando em ciclos próprios enquanto o loop de staging está lento (mesmo padrão de main())', async () => {
  const dispatchGuard = createSingleFlightGuard();
  const stagingGuard = createSingleFlightGuard();
  let dispatchCycles = 0;
  let stagingCycles = 0;
  let stopping = false;
  let releaseStaging;
  const stagingGate = new Promise((resolve) => { releaseStaging = resolve; });

  async function dispatchLoop() {
    while (!stopping) {
      await dispatchGuard.run(async () => {
        dispatchCycles += 1;
      });
      if (dispatchCycles >= 5) { stopping = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  async function stagingLoop() {
    await stagingGuard.run(async () => {
      stagingCycles += 1;
      await stagingGate;
    });
  }

  const loops = Promise.all([dispatchLoop(), stagingLoop()]);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(stagingCycles, 1, 'staging deveria estar preso no primeiro ciclo lento');
  assert.ok(dispatchCycles >= 3, `dispatch deveria ter avançado vários ciclos independentes, obteve ${dispatchCycles}`);

  releaseStaging();
  await loops;
});
