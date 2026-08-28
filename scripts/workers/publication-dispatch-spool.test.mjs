import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PublicationDispatchSpool } from './publication-dispatch-spool.mjs';

async function withSpool(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'athena-publication-spool-'));
  try {
    const spool = await new PublicationDispatchSpool(directory).initialize();
    await run(spool, directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function envelope(itemId, executeAt, organizationId = 'org-a', profileId = 'profile-a') {
  return { itemId, executeAt, organizationId, profileId, workItem: { id: itemId, profile: { status: 'online' } } };
}

test('spool grava atomicamente, recupera após restart e remove por item', async () => {
  await withSpool(async (spool, directory) => {
    const id = '00000000-0000-4000-8000-000000000001';
    await spool.put(envelope(id, '2026-08-28T07:00:00.000Z'));
    assert.equal((await fs.readdir(directory)).some((name) => name.endsWith('.tmp')), false);
    assert.equal((await new PublicationDispatchSpool(directory).initialize().then((next) => next.get(id))).itemId, id);
    await spool.remove(id);
    assert.equal(await spool.get(id), null);
  });
});

test('spool retorna somente vencidos em ordem justa e respeita limite', async () => {
  await withSpool(async (spool) => {
    await spool.put(envelope('00000000-0000-4000-8000-000000000003', '2026-08-28T07:02:00.000Z', 'org-b'));
    await spool.put(envelope('00000000-0000-4000-8000-000000000002', '2026-08-28T07:01:00.000Z', 'org-a'));
    await spool.put(envelope('00000000-0000-4000-8000-000000000001', '2026-08-28T07:03:00.000Z', 'org-a'));
    const due = await spool.listDue(Date.parse('2026-08-28T07:02:30.000Z'), 1);
    assert.deepEqual(due.map((entry) => entry.itemId), ['00000000-0000-4000-8000-000000000002']);
  });
});

test('spool rejeita envelope sem identidade ou snapshot', async () => {
  await withSpool(async (spool) => {
    await assert.rejects(() => spool.put({ itemId: '../escape', executeAt: new Date().toISOString(), workItem: {} }));
    await assert.rejects(() => spool.put({ itemId: '00000000-0000-4000-8000-000000000001', executeAt: 'invalid' }));
  });
});
