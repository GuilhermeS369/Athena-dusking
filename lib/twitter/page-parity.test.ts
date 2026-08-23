import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('revisão em massa entrega exatamente o contrato financeiro renderizado pela tela', async () => {
  const [route, client] = await Promise.all([
    readFile(new URL('../../app/api/x/bulk/review/route.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../app/x/twitter-bulk-client.tsx', import.meta.url), 'utf8'),
  ]);
  for (const field of ['costBreakdown', 'walletSnapshots', 'shortfalls', 'reservedMicros']) {
    assert.match(route, new RegExp(`${field}: review\\.${field}`));
    assert.match(client, new RegExp(`review\\.${field}`));
  }
  assert.doesNotMatch(route, /wallets:review\.walletSnapshots|wallets:\s*review\.walletSnapshots/);
  assert.match(client, /contrato incompleto/);
  assert.doesNotMatch(`${route}\n${client}`, /instagram_profiles|public\.publication_items/);
});

test('remoção de mídia preserva objeto congelado e grupos X permitem edição', async () => {
  const [mediaRoute, gallery, groups] = await Promise.all([
    readFile(new URL('../../app/api/x/media/[assetId]/route.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../app/x/twitter-gallery-client.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../app/x/twitter-groups-client.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(mediaRoute, /twitter_program_media_set_assets/);
  assert.match(mediaRoute, /storageRetained/);
  assert.ok(mediaRoute.indexOf("status: 'deleted'") < mediaRoute.indexOf("storage.from('twitter-media').remove"));
  assert.match(gallery, /Programas já confirmados continuarão preservando o arquivo/);
  assert.match(gallery, /<video/);
  assert.match(groups, /method: editingId \? 'PUT' : 'POST'/);
  assert.match(groups, /description/);
  assert.match(groups, /if \(!response\.ok\) throw new Error/);
  assert.doesNotMatch(`${mediaRoute}\n${gallery}\n${groups}`, /instagram_profiles|instagram-media/);
});
