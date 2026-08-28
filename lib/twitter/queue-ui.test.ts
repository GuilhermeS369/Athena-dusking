import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('fila X replica a visão operacional nova com cancelamento durável por conta, lote e grupo', async () => {
  const [page, client, cancelRoute, listRoute, migration, scaleMigration] = await Promise.all([
    readFile(new URL('../../app/(painel)/x/fila/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../app/x/twitter-queue-client.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../app/api/x/queue/cancel/route.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../app/api/x/queue/route.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../supabase/migrations/257_twitter_queue_reference_summary_and_cancellation_operations.sql', import.meta.url), 'utf8'),
    readFile(new URL('../../supabase/migrations/267_twitter_publication_scale_and_safety.sql', import.meta.url), 'utf8'),
  ]);
  for (const scope of ["'account'", "'batch'", "'group'", "'item'"]) assert.match(client, new RegExp(scope));
  assert.match(client, /Por conta/);
  assert.match(client, /Por lote/);
  assert.match(client, /Por grupo/);
  assert.match(client, /Cancelar fila/);
  assert.match(client, /Cancelar lote/);
  assert.match(client, /Cancelar grupo/);
  assert.match(client, /localStorage/);
  assert.match(client, /retomad[oa] automaticamente/);
  assert.doesNotMatch(client, /groupProfileIds:/);
  assert.match(client, /Resultado incerto/);
  assert.match(client, /não libera o hold sem[\s\S]*reconciliação/);
  assert.match(cancelRoute, /twitter_process_queue_cancellation_operation/);
  assert.match(cancelRoute, /getTwitterRequestContext\('operator'\)/);
  assert.match(cancelRoute, /twitter_queue_cancellation_operations/);
  assert.match(cancelRoute, /twitter_queue_cancellation_targets/);
  assert.match(scaleMigration, /skip locked limit chunk/);
  assert.match(scaleMigration, /twitter_process_queue_cancellation_operation/);
  assert.match(migration, /twitter_queue_operational_summary/);
  assert.match(migration, /twitter_queue_cancellation_operations/);
  assert.match(page, /twitter_program_shortfalls/);
  assert.match(page, /\.eq\('program_id', programIds\[0\]\)/);
  assert.match(client, /api\/x\/queue\?programId=/);
  assert.match(listRoute, /\.eq\('program_id', programId\)/);
  assert.match(listRoute, /\.limit\(201\)/);
  assert.match(listRoute, /nextCursor/);
  assert.match(client, /Ver mais publicações/);
  assert.match(page, /twitter_program_queue_overview/);
  assert.doesNotMatch(`${page}\n${client}\n${cancelRoute}\n${listRoute}\n${migration}\n${scaleMigration}`, /instagram_profiles|public\.publication_items/);
});
