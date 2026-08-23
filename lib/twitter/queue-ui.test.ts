import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('fila X expõe cancelamento granular sem cruzar estruturas Instagram', async () => {
  const [page, client, cancelRoute, listRoute] = await Promise.all([
    readFile(new URL('../../app/(painel)/x/fila/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../app/x/twitter-queue-client.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../app/api/x/queue/cancel/route.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../app/api/x/queue/route.ts', import.meta.url), 'utf8'),
  ]);
  for (const field of ['itemId', 'programId', 'profileId', 'groupProfileIds']) assert.match(client, new RegExp(field));
  assert.match(client, /Resultado incerto/);
  assert.match(client, /não libera o hold sem reconciliação/);
  assert.match(cancelRoute, /twitter_cancel_publication_scope/);
  assert.match(cancelRoute, /getTwitterRequestContext\('operator'\)/);
  assert.match(page, /twitter_program_shortfalls/);
  assert.match(page, /\.eq\('program_id', programIds\[0\]\)/);
  assert.match(client, /api\/x\/queue\?programId=/);
  assert.match(listRoute, /\.eq\('program_id', programId\)/);
  assert.match(listRoute, /\.limit\(500\)/);
  assert.doesNotMatch(`${page}\n${client}\n${cancelRoute}\n${listRoute}`, /instagram_profiles|public\.publication_items/);
});
