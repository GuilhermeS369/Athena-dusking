import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveTwitterHeartbeatWrite } from './heartbeat-cadence.ts';

const NOW = Date.parse('2026-08-28T12:00:00.000Z');
const MIN = 25_000;

function at(offsetMs: number) {
  return new Date(NOW - offsetMs).toISOString();
}

test('sem heartbeat anterior grava e conta como transição', () => {
  assert.deepEqual(
    resolveTwitterHeartbeatWrite({ previous: null, mode: 'live', nowMs: NOW, minWriteIntervalMs: MIN }),
    { modeChanged: true, heartbeatDue: true },
  );
});

test('troca apenas de worker_id não é transição de estado nem regrava', () => {
  // Regressão do fan-out: as instâncias do cluster de publicação revezam a mesma
  // linha, e comparar worker_id disparava um evento por organização quase todo ciclo.
  const decision = resolveTwitterHeartbeatWrite({
    previous: { worker_id: 'publication-host-101', mode: 'live', last_seen_at: at(1_800) },
    mode: 'live',
    nowMs: NOW,
    minWriteIntervalMs: MIN,
  });
  assert.deepEqual(decision, { modeChanged: false, heartbeatDue: false });
});

test('mudança de mode sempre regrava e sinaliza transição, mesmo com carimbo recente', () => {
  assert.deepEqual(
    resolveTwitterHeartbeatWrite({
      previous: { worker_id: 'publication-host-101', mode: 'live', last_seen_at: at(200) },
      mode: 'stopped',
      nowMs: NOW,
      minWriteIntervalMs: MIN,
    }),
    { modeChanged: true, heartbeatDue: true },
  );
});

test('regrava assim que a janela mínima vence', () => {
  const antes = resolveTwitterHeartbeatWrite({
    previous: { mode: 'live', last_seen_at: at(MIN - 1) },
    mode: 'live', nowMs: NOW, minWriteIntervalMs: MIN,
  });
  const depois = resolveTwitterHeartbeatWrite({
    previous: { mode: 'live', last_seen_at: at(MIN) },
    mode: 'live', nowMs: NOW, minWriteIntervalMs: MIN,
  });
  assert.equal(antes.heartbeatDue, false);
  assert.equal(depois.heartbeatDue, true);
});

test('a janela fica muito abaixo da tolerância de 120s do failover', () => {
  // Garante margem: mesmo pulando escritas, o gate de stale nunca é atingido.
  const toleranciaFailoverMs = 120_000;
  assert.ok(MIN * 2 < toleranciaFailoverMs);
  assert.equal(
    resolveTwitterHeartbeatWrite({
      previous: { mode: 'live', last_seen_at: at(toleranciaFailoverMs / 2) },
      mode: 'live', nowMs: NOW, minWriteIntervalMs: MIN,
    }).heartbeatDue,
    true,
  );
});

test('carimbo ausente, ilegível ou no futuro regrava em vez de silenciar o heartbeat', () => {
  for (const last_seen_at of [null, undefined, '', 'nao-e-data']) {
    assert.equal(
      resolveTwitterHeartbeatWrite({ previous: { mode: 'live', last_seen_at }, mode: 'live', nowMs: NOW, minWriteIntervalMs: MIN }).heartbeatDue,
      true,
    );
  }
  assert.equal(
    resolveTwitterHeartbeatWrite({
      previous: { mode: 'live', last_seen_at: new Date(NOW + 60_000).toISOString() },
      mode: 'live', nowMs: NOW, minWriteIntervalMs: MIN,
    }).heartbeatDue,
    true,
  );
});

test('intervalo zero desliga o throttle e preserva o comportamento anterior', () => {
  assert.equal(
    resolveTwitterHeartbeatWrite({
      previous: { mode: 'live', last_seen_at: at(0) },
      mode: 'live', nowMs: NOW, minWriteIntervalMs: 0,
    }).heartbeatDue,
    true,
  );
});
