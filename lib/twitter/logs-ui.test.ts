import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('centro de observabilidade X usa incidentes, listas e paginação independentes', async () => {
  const [page, client, migration, eventsRoute] = await Promise.all([
    readFile(new URL('../../app/(painel)/x/logs/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../app/x/twitter-logs-center.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../supabase/migrations/259_twitter_observability_center.sql', import.meta.url), 'utf8'),
    readFile(new URL('../../app/api/x/logs/events/route.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(page, /Centro de observabilidade/);
  for (const label of ['Atenção', 'Quedas de contas', 'Agendamentos', 'Postagens e fila', 'Workers', 'Zernio e conexões', 'Analytics e financeiro', 'Toda a atividade']) assert.ok(client.includes(label), label);
  assert.match(client, /Carregar mais 50/);
  assert.match(client, /Evidências técnicas/);
  assert.match(migration, /twitter_observability_events/);
  assert.match(migration, /partition by range/);
  assert.match(migration, /twitter_observability_incidents/);
  assert.match(migration, /twitter_operation_logs/);
  assert.match(eventsRoute, /limit\(limit \+ 1\)/);
  assert.doesNotMatch(`${page}\n${client}`, /\/v1\//);
});

test('viewer recebe evidência sanitizada e não recebe ações de incidente ou reconciliação', async () => {
  const [client, occurrences, statusRoute] = await Promise.all([
    readFile(new URL('../../app/x/twitter-logs-center.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../app/api/x/logs/incidents/[incidentId]/occurrences/route.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../app/api/x/logs/incidents/[incidentId]/status/route.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(client, /const canManage = role !== "viewer"/);
  assert.match(client, /canManage && event\.event_type === "outcome_unknown"/);
  assert.match(occurrences, /const canInspect = auth\.context\.activeOrganization\.role !== "viewer"/);
  assert.match(statusRoute, /getTwitterRequestContext\("operator"\)/);
});

test('reconciliação explica que não repete a chamada externa', async () => {
  const source = await readFile(new URL('../../app/x/twitter-log-resolution.tsx', import.meta.url), 'utf8');
  assert.match(source, /Esta ação não\s+repete a chamada original/);
  assert.match(source, /justification: j/);
});
