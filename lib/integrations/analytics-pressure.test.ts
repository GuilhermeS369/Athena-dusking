import assert from 'node:assert/strict';
import test from 'node:test';

import { analyticsPressureConfig, decideAnalyticsPressure, resolveAnalyticsPressure } from './analytics-pressure.ts';

function config(overrides: Partial<ReturnType<typeof analyticsPressureConfig>> = {}) {
  return {
    criticalDelaySeconds: 600,
    degradedPercent: 50,
    pauseEnabled: false,
    enabled: true,
    ...overrides,
  };
}

test('sem atraso crítico o analytics roda com a concorrência pedida', () => {
  const decision = decideAnalyticsPressure({
    pressure: { criticalDelay: false },
    concurrency: 10,
    limit: 20,
    config: config(),
  });
  assert.equal(decision.mode, 'full');
  assert.equal(decision.concurrency, 10);
  assert.equal(decision.limit, 20);
});

test('atraso crítico degrada pela metade, nunca interrompe a coleta', () => {
  // O ponto do P0: 30/08/2026 o analytics ficou 9h36 sem coletar porque cedia
  // por completo. Degradar mantém a fila de analytics andando.
  const decision = decideAnalyticsPressure({
    pressure: { criticalDelay: true, oldestDueAt: '2026-08-30T04:00:00Z' },
    concurrency: 10,
    limit: 20,
    config: config(),
  });
  assert.equal(decision.mode, 'degraded');
  assert.equal(decision.concurrency, 5);
  assert.equal(decision.limit, 10);
});

test('degradação tem piso de 1: worker pequeno continua processando', () => {
  const decision = decideAnalyticsPressure({
    pressure: { criticalDelay: true },
    concurrency: 1,
    limit: 1,
    config: config(),
  });
  assert.equal(decision.mode, 'degraded');
  assert.equal(decision.concurrency, 1);
  assert.equal(decision.limit, 1);
});

test('a válvula de escape restaura a pausa total quando a operação da fila pedir', () => {
  const decision = decideAnalyticsPressure({
    pressure: { criticalDelay: true },
    concurrency: 10,
    limit: 20,
    config: config({ pauseEnabled: true }),
  });
  assert.equal(decision.mode, 'paused');
  assert.equal(decision.concurrency, 0);
});

test('sinal ausente não interrompe o analytics', () => {
  const decision = decideAnalyticsPressure({ pressure: null, concurrency: 8, limit: 16, config: config() });
  assert.equal(decision.mode, 'full');
  assert.equal(decision.concurrency, 8);
});

test('o limiar enviado é o do analytics e fica acima do pior atraso de uma fila saudável', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    rpc(name: string, params: Record<string, unknown>) {
      calls.push({ name, ...params });
      return Promise.resolve({ data: { criticalDelay: false }, error: null });
    },
  };

  const decision = await resolveAnalyticsPressure(client, { concurrency: 10, limit: 20 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'get_publication_generation_pressure_signal');
  assert.equal(calls[0].p_critical_delay_seconds, analyticsPressureConfig().criticalDelaySeconds);
  // Com a fila saudável (30/08/2026, pós-correção do staging) o pior atraso
  // observado foi 597s e o p90 foi 399s. Abaixo disso o sinal fica verdadeiro
  // em operação normal e deixa de discriminar qualquer coisa; muito acima, ele
  // nunca dispara e vira código morto.
  const limiar = calls[0].p_critical_delay_seconds as number;
  assert.ok(limiar >= 597, 'o limiar precisa ficar acima do pior atraso já visto com a fila sã');
  assert.ok(limiar <= 900, 'um limiar alto demais nunca dispara e vira código morto');
  assert.equal(decision.mode, 'full');
});
