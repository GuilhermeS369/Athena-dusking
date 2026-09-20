import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  addBandwidth,
  bandwidthAlertLevel,
  classifyVariantError,
  createSemaphore,
  mapWithConcurrency,
  planCacheEviction,
  variantStoragePath,
} from './publication-video-variant-worker.mjs';

const source = fs.readFileSync(new URL('./publication-video-variant-worker.mjs', import.meta.url), 'utf8');

test('o semaforo nunca deixa passar do limite (teto de conexoes do banco)', async () => {
  const withPermit = createSemaphore(2);
  let active = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 25 }, () => withPermit(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
  })));
  assert.equal(peak, 2);
});

test('o semaforo libera a vaga mesmo quando a tarefa falha', async () => {
  const withPermit = createSemaphore(1);
  await assert.rejects(withPermit(async () => { throw new Error('x'); }));
  assert.equal(await withPermit(async () => 'ok'), 'ok');
});

test('mapWithConcurrency preserva a ordem e respeita o limite', async () => {
  let active = 0;
  let peak = 0;
  const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return value * 10;
  });
  assert.deepEqual(results, [10, 20, 30, 40, 50, 60, 70]);
  assert.ok(peak <= 3);
});

test('o caminho da variante e unico por item e por tentativa', () => {
  const base = { organizationId: 'org', itemId: 'item-1', executeAt: '2026-09-21T10:03:00Z' };
  const first = variantStoragePath({ ...base, tagUuid: 'aaaaaaaaaaaabbbb' });
  const second = variantStoragePath({ ...base, tagUuid: 'ccccccccccccdddd' });
  assert.equal(first, 'org/variants/2026-09-21/item-1-aaaaaaaaaaaa.mp4');
  assert.notEqual(first, second);
});

test('o cache descarta o menos usado e nunca o arquivo em uso', () => {
  const entries = [
    { key: 'a', sizeBytes: 40, lastUsedAt: 1 },
    { key: 'b', sizeBytes: 40, lastUsedAt: 2 },
    { key: 'c', sizeBytes: 40, lastUsedAt: 3 },
  ];
  assert.deepEqual(planCacheEviction(entries, 100), ['a']);
  assert.deepEqual(planCacheEviction(entries, 100, new Set(['a'])), ['b']);
  assert.deepEqual(planCacheEviction(entries, 200), []);
});

test('a franquia de banda avisa em 60% e 80% e o contador vira com o dia e o mes', () => {
  assert.equal(bandwidthAlertLevel(59, 100), 'ok');
  assert.equal(bandwidthAlertLevel(60, 100), 'warning');
  assert.equal(bandwidthAlertLevel(80, 100), 'critical');
  assert.equal(bandwidthAlertLevel(999, 0), 'ok');

  let state = addBandwidth({}, 10, new Date('2026-09-30T23:00:00Z'));
  state = addBandwidth(state, 5, new Date('2026-09-30T23:30:00Z'));
  assert.deepEqual([state.dayBytes, state.monthBytes], [15, 15]);
  state = addBandwidth(state, 7, new Date('2026-10-01T00:10:00Z'));
  assert.deepEqual([state.day, state.dayBytes, state.month, state.monthBytes], ['2026-10-01', 7, '2026-10', 7]);
});

test('defeito do arquivo de origem e terminal; o resto recua ate 15 min', () => {
  const missing = Object.assign(new Error('x'), { variantCode: 'video_variant_source_missing' });
  assert.deepEqual(classifyVariantError(missing, 1), { code: 'video_variant_source_missing', terminal: true, retrySeconds: 30 });
  const ffmpeg = Object.assign(new Error('x'), { variantCode: 'video_variant_ffmpeg_failed' });
  assert.equal(classifyVariantError(ffmpeg, 1).terminal, false);
  assert.equal(classifyVariantError(ffmpeg, 3).retrySeconds, 120);
  assert.equal(classifyVariantError(ffmpeg, 12).retrySeconds, 900);
  assert.equal(classifyVariantError(new Error('rede'), 1).terminal, false);
});

// Guardas de texto: decisoes que um refactor distraido desfaria sem nenhum teste cair.
test('upload e UM PutObject por arquivo: sem multipart e sem lib-storage', () => {
  assert.ok(source.includes('PutObjectCommand'));
  assert.ok(!/lib-storage|CreateMultipartUpload|UploadPartCommand/.test(source));
  const packageJson = fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
  assert.ok(!packageJson.includes('@aws-sdk/lib-storage'));
});

test('o worker nao toca no caminho quente da fila nem em token de perfil', () => {
  assert.ok(!source.includes('claim_publication_items'));
  assert.ok(!/from\(['"]publication_items['"]\)/.test(source));
  assert.ok(!source.includes('encrypted_access_token'));
});

test('o worker recusa usar o bucket dos originais como bucket de variantes', () => {
  assert.ok(source.includes('config.variantBucket === config.sourceBucket'));
});

test('toda chamada de banco passa pelo semaforo', () => {
  const direct = source.match(/supabase\.rpc\(/g) ?? [];
  const guarded = source.match(/database\(\((supabase|client)\) => (supabase|client)\.rpc\(/g) ?? [];
  assert.equal(direct.length + (source.match(/client\.rpc\(/g) ?? []).length, guarded.length);
});
