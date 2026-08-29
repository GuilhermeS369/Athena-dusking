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

// Fase 9 do plano de despacho Instagram: "testar restart com 1.000 envelopes já persistidos".
// Escreve 1.000 envelopes (simulando o worker parando com o spool cheio), mais alguns
// arquivos .tmp órfãos (simulando um crash no meio de uma escrita atômica), depois recupera
// com uma instância nova do spool (mesmo diretório, sem esperar nenhum lease/estado antigo)
// e confirma que todos os 1.000 são recuperados corretamente e os .tmp somem.
test('spool recupera 1.000 envelopes persistidos após reinício, sem esperar lease/worker antigo', async () => {
  await withSpool(async (spool, directory) => {
    const total = 1000;
    const startedAt = Date.now();
    for (let index = 0; index < total; index += 1) {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      await spool.put(envelope(id, new Date(Date.parse('2026-08-28T07:00:00.000Z') + index * 1000).toISOString(), `org-${index % 10}`, `profile-${index % 50}`));
    }
    const writeElapsedMs = Date.now() - startedAt;

    // Simula um crash no meio de uma escrita atômica: arquivos .tmp órfãos no diretório.
    await fs.writeFile(path.join(directory, 'orphan-1.tmp'), '{"incomplete":true}', 'utf8');
    await fs.writeFile(path.join(directory, 'orphan-2.tmp'), '{"incomplete":true}', 'utf8');

    const restartedAt = Date.now();
    const recovered = await new PublicationDispatchSpool(directory).initialize();
    const initializeElapsedMs = Date.now() - restartedAt;

    const remainingTmp = (await fs.readdir(directory)).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(remainingTmp, [], 'arquivos .tmp órfãos deveriam ser limpos na inicialização');

    const listedAt = Date.now();
    const all = await recovered.list();
    const listElapsedMs = Date.now() - listedAt;
    assert.equal(all.length, total, `deveria recuperar todos os ${total} envelopes`);

    const dueAt = Date.now();
    const due = await recovered.listDue(Date.parse('2026-08-28T07:00:00.000Z') + 500 * 1000, 5000);
    const listDueElapsedMs = Date.now() - dueAt;
    assert.equal(due.length, 501, 'listDue deveria filtrar corretamente por execute_at mesmo em 1.000 arquivos');

    console.info('[spool restart 1000] tempos', { writeElapsedMs, initializeElapsedMs, listElapsedMs, listDueElapsedMs });
  });
});
