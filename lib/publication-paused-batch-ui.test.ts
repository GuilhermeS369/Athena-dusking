import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('fila torna pausa por limite de erros visível e atualizada', async () => {
  const [client, hook, route] = await Promise.all([
    readFile(new URL('../app/queue/queue-client.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../app/queue/use-publication-queue.ts', import.meta.url), 'utf8'),
    readFile(new URL('../app/api/publications/paused-batches/route.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(client, /Pausado por limite de erros/);
  assert.match(client, /Nenhum item é retomado automaticamente/);
  assert.match(client, /pausedBatch \? 'paused'/);
  assert.match(hook, /paused-batches/);
  assert.match(hook, /10_000/);
  assert.match(hook, /visibilitychange/);
  assert.match(route, /get_paused_publication_batch_alerts/);
});
