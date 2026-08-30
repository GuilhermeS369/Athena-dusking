import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSingleFlightGuard,
  dispatchHasOperationalActivity,
  fairDispatchOrder,
  selectWithinOrganizationDispatchWindow,
  shouldForceStagingThroughCriticalDelay,
  shouldStagingYieldToPressure,
  stagingHasSafeWindow,
  shouldPreparationYieldToDispatch,
  shouldYieldToDueWindow,
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

// Reproduz o cenário de plans/plano-correcao-deadlock-staging-criticaldelay-2026-08-28.md:
// atraso crítico causado só por itens não iniciados (creation_id nulo) nunca deveria fazer
// o staging ceder, porque staging é a única fase capaz de resolvê-lo.
test('staging não cede ao atraso crítico quando ele é só de itens não iniciados', () => {
  assert.equal(shouldStagingYieldToPressure({
    criticalDelay: true, overdueAccepted: false, overdueUnstarted: true,
  }), false);
});

test('staging cede ao atraso crítico quando há itens já aceitos competindo por despacho', () => {
  assert.equal(shouldStagingYieldToPressure({
    criticalDelay: true, overdueAccepted: true, overdueUnstarted: false,
  }), true);
});

test('staging não cede quando não há atraso crítico', () => {
  assert.equal(shouldStagingYieldToPressure({ criticalDelay: false, overdueAccepted: false }), false);
  assert.equal(shouldStagingYieldToPressure(null), false);
});

test('sinal antigo sem a distinção aceito/não-iniciado mantém o comportamento anterior (cede)', () => {
  assert.equal(shouldStagingYieldToPressure({ criticalDelay: true, overdueAccepted: null }), true);
  assert.equal(shouldStagingYieldToPressure({ criticalDelay: true }), true);
});

test('teto de segurança força o staging depois do tempo limite cedendo continuamente', () => {
  const startedAt = 1_000_000;
  assert.equal(shouldForceStagingThroughCriticalDelay(null, startedAt, 300_000), false);
  assert.equal(shouldForceStagingThroughCriticalDelay(startedAt, startedAt + 299_999, 300_000), false);
  assert.equal(shouldForceStagingThroughCriticalDelay(startedAt, startedAt + 300_000, 300_000), true);
});

// Separação da preparação em laço próprio (29/08/2026). Antes,
// preparePublicationQueueDirect rodava DENTRO de dispatchPublicationQueueDirect,
// no mesmo ciclo que publica — então o limite de preparação ficava preso em
// valores baixos (4 em produção, medido em 960 itens/hora), porque subir
// atrasava a publicação de item vencido. Este teste prova o que a separação
// comprou: preparação travada não impede o despacho de avançar.
test('loop de dispatch continua publicando enquanto o loop de preparação está travado', async () => {
  const dispatchGuard = createSingleFlightGuard();
  const preparationGuard = createSingleFlightGuard();
  let dispatchCycles = 0;
  let preparationCycles = 0;
  let stopping = false;
  let releasePreparation;
  const preparationGate = new Promise((resolve) => { releasePreparation = resolve; });

  async function dispatchLoop() {
    while (!stopping) {
      await dispatchGuard.run(async () => {
        dispatchCycles += 1;
      });
      if (dispatchCycles >= 5) { stopping = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  async function preparationLoop() {
    await preparationGuard.run(async () => {
      preparationCycles += 1;
      await preparationGate;
    });
  }

  const loops = Promise.all([dispatchLoop(), preparationLoop()]);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(preparationCycles, 1, 'preparação deveria estar presa no primeiro ciclo lento');
  assert.ok(dispatchCycles >= 3, `dispatch deveria ter avançado vários ciclos independentes, obteve ${dispatchCycles}`);

  releasePreparation();
  await loops;
});

// O mutex precisa impedir que um ciclo de preparação lento seja sobreposto pelo
// seguinte: duas preparações concorrentes reivindicariam os mesmos itens e
// dobrariam a carga de mídia sem ganho.
test('o mutex da preparação impede ciclos sobrepostos', async () => {
  const guard = createSingleFlightGuard();
  let concurrent = 0;
  let maxConcurrent = 0;

  const cycle = async () => guard.run(async () => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 5));
    concurrent -= 1;
  });

  await Promise.all([cycle(), cycle(), cycle()]);
  assert.equal(maxConcurrent, 1, 'nunca deveria haver dois ciclos de preparação ao mesmo tempo');
});

// MEDIDO EM PRODUÇÃO (29/08/2026): a primeira versão da separação reusava a
// janela do staging (60 s) sem teto de cessão. Com ~4.000 publicações/hora
// sempre havia item vencendo nos próximos 60 s, então a preparação cedia em
// TODOS os ciclos e ficava com `claimed: 0` — 200 itens pendentes parados.
test('a preparação cede ao despacho, mas nunca de forma indefinida', () => {
  // Sem publicação próxima, roda sempre — a cessão nem entra em cena.
  assert.equal(shouldPreparationYieldToDispatch(false, 0, 3), false);
  assert.equal(shouldPreparationYieldToDispatch(false, 99, 3), false);

  // Com publicação próxima, cede — até o teto.
  assert.equal(shouldPreparationYieldToDispatch(true, 0, 3), true);
  assert.equal(shouldPreparationYieldToDispatch(true, 2, 3), true);

  // Atingido o teto, roda de qualquer forma: preparação parada é o que produz
  // item vencido, então ceder para sempre trocaria o problema de lugar.
  assert.equal(shouldPreparationYieldToDispatch(true, 3, 3), false);
  assert.equal(shouldPreparationYieldToDispatch(true, 10, 3), false);

  // Teto zero desliga a cessão por completo.
  assert.equal(shouldPreparationYieldToDispatch(true, 0, 0), false);
});

// A4.7: itens irmãos do mesmo perfil saíam juntos no mesmo lote, com
// concorrência 32, e chegavam à reserva de capacidade no mesmo instante — o que
// produzia intervalos de 0 min entre reels do mesmo perfil.
test('o lote leva no máximo um item por perfil e formato', () => {
  const now = Date.parse('2026-08-29T21:30:00Z');
  const result = selectWithinOrganizationDispatchWindow([
    { itemId: 'r1', organizationId: 'a', profileId: 'p1', format: 'reel', executeAt: '2026-08-29T21:29:00Z' },
    { itemId: 'r2', organizationId: 'a', profileId: 'p1', format: 'reel', executeAt: '2026-08-29T21:29:01Z' },
    { itemId: 's1', organizationId: 'a', profileId: 'p1', format: 'story', executeAt: '2026-08-29T21:29:02Z' },
    { itemId: 'r3', organizationId: 'a', profileId: 'p2', format: 'reel', executeAt: '2026-08-29T21:29:03Z' },
  ], new Map(), now, 10, 100);

  // O segundo reel do perfil p1 fica para o ciclo seguinte; story e o outro
  // perfil passam, porque são trilhas independentes.
  assert.deepEqual(result.selected.map((item) => item.itemId), ['r1', 's1', 'r3']);
});

test('envelope antigo sem formato cai no comportamento conservador de um por perfil', () => {
  const now = Date.parse('2026-08-29T21:30:00Z');
  const result = selectWithinOrganizationDispatchWindow([
    { itemId: 'v1', organizationId: 'a', profileId: 'p1', executeAt: '2026-08-29T21:29:00Z' },
    { itemId: 'v2', organizationId: 'a', profileId: 'p1', executeAt: '2026-08-29T21:29:01Z' },
  ], new Map(), now, 10, 100);
  assert.deepEqual(result.selected.map((item) => item.itemId), ['v1']);
});

// MEDIDO EM PRODUCAO (30/08/2026): o heartbeat mostrava o staging com
// `skipped: 'publication_due_within_guard'` e `claimed: 0`, enquanto o contador
// do teto de pressao critica ficava em 0 - prova de que quem barrava era o guard
// de 60 s, que nao tinha teto de cessao. O staging so rodava nos intervalos
// entre ondas, serializando um pipeline que deveria trabalhar adiantado.
test('o staging cede ao despacho, mas nunca de forma indefinida', () => {
  // Sem publicacao proxima, roda sempre.
  assert.equal(shouldYieldToDueWindow(false, 0, 3), false);
  assert.equal(shouldYieldToDueWindow(false, 99, 3), false);

  // Com publicacao proxima, cede ate o teto.
  assert.equal(shouldYieldToDueWindow(true, 0, 3), true);
  assert.equal(shouldYieldToDueWindow(true, 2, 3), true);

  // Atingido o teto, roda de qualquer forma: staging parado esvazia o spool e
  // deixa o despacho sem o que publicar, que e o oposto do que o guard queria.
  assert.equal(shouldYieldToDueWindow(true, 3, 3), false);
  assert.equal(shouldYieldToDueWindow(true, 50, 3), false);

  // Teto zero desliga a cessao por completo.
  assert.equal(shouldYieldToDueWindow(true, 0, 0), false);
});
