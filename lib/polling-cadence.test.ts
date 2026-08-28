import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

test('nenhum loop de polling do painel consulta com a aba oculta', async () => {
  const [queueHook, logsCenter, additions, zernio, observability] = await Promise.all([
    read('../app/queue/use-publication-queue.ts'),
    read('../app/x/twitter-logs-center.tsx'),
    read('../app/(painel)/operacao/adicoes-zernio/zernio-additions-client.tsx'),
    read('../app/zernio/zernio-client.tsx'),
    read('../app/operacao/instagram-observability-center.tsx'),
  ]);

  for (const [nome, fonte] of Object.entries({ queueHook, logsCenter, additions, zernio, observability })) {
    assert.match(fonte, /visibilityState/, `${nome} precisa checar document.visibilityState antes de consultar`);
  }
});

test('o resumo agregado da fila é consultado numa cadência menor que o progresso da geração', async () => {
  const hook = await read('../app/queue/use-publication-queue.ts');

  // O resumo materializa todos os itens não arquivados da organização e roda
  // catorze agregados, três deles count(distinct profile_id). Ele não pode voltar
  // ao mesmo tick de 10 s do progresso de geração.
  assert.match(hook, /SUMMARY_POLL_INTERVAL_MS = 60_000/);
  assert.match(hook, /lastSummaryPollAtRef/);
  assert.match(hook, /now - lastSummaryPollAtRef\.current < SUMMARY_POLL_INTERVAL_MS/);
  // Qualquer consulta ao resumo reinicia a janela, inclusive as disparadas pelo usuário.
  assert.match(hook, /lastSummaryPollAtRef\.current = Date\.now\(\);/);
});

test('o acompanhamento de conexão X para em estado terminal em vez de consultar para sempre', async () => {
  const progress = await read('../app/x/twitter-connect-progress.tsx');

  // setInterval não tem como parar sozinho no estado terminal: a versão anterior
  // consultava a cada 1,8 s indefinidamente numa aba esquecida aberta.
  assert.doesNotMatch(progress, /setInterval/);
  assert.match(progress, /TERMINAL_STATUSES\.includes\(payload\.status\)\) return;/);
  assert.match(progress, /window\.clearTimeout\(timer\)/);
});

test('a fila de espera Zernio não continua consultando após o unmount', async () => {
  const waiting = await read('../app/(painel)/zernio/aguardando/waiting-client.tsx');

  // A regressão original: o catch reagendava sem checar `cancelled` e o cleanup
  // não limpava o timer, então o polling sobrevivia ao unmount enquanto falhasse.
  // Todo reagendamento precisa passar pelo helper protegido, nunca por um
  // setTimeout com atraso literal solto no corpo do poll.
  assert.doesNotMatch(waiting, /setTimeout\(poll, ?\d/);
  assert.match(waiting, /const schedule = \(delay: number\) => \{ if \(!cancelled\)/);
  assert.match(waiting, /window\.clearTimeout\(timer\)/);
});

test('o resumo operacional X usa uma varredura agregada em vez de contagens repetidas', async () => {
  const [route, migration] = await Promise.all([
    read('../app/api/x/logs/summary/route.ts'),
    read('../supabase/migrations/316_twitter_observability_summary_counts.sql'),
  ]);

  assert.match(route, /twitter_observability_summary_counts/);
  assert.match(migration, /count\(\*\) filter/);
  // O caminho antigo permanece apenas como fallback de ordem de deploy.
  assert.match(route, /countsViaScans/);
  assert.match(route, /migration 316 indisponível/);
});

test('o heartbeat X só emite evento em transição de estado, não a cada troca de PID', async () => {
  const route = await read('../app/api/internal/twitter-heartbeat/route.ts');

  assert.match(route, /resolveTwitterHeartbeatWrite/);
  assert.match(route, /if \(modeChanged\) \{/);
  // Comparar worker_id disparava fan-out por organização em quase todo ciclo,
  // porque as instâncias do cluster de publicação revezam a mesma linha.
  assert.doesNotMatch(route, /previous\.worker_id !== body\.workerId/);
});

test('o worker X não reenvia circuit breaker success já fechado', async () => {
  const worker = await read('../scripts/workers/twitter-worker.mjs');

  assert.match(worker, /if\(lastCycleFailed\|\|breakerNeedsReset\)/);
  assert.match(worker, /breakerNeedsReset=heartbeat\.circuitBreaker\?\.state!=='closed'/);
});
