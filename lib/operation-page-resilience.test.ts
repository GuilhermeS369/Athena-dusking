import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('falha de uma API de observabilidade nao derruba a pagina operacional', async () => {
  const [page, client] = await Promise.all([
    readFile(new URL('app/(painel)/operacao/page.tsx', root), 'utf8'),
    readFile(new URL('app/operacao/instagram-observability-center.tsx', root), 'utf8'),
  ]);

  assert.doesNotMatch(page, /dispatchTelemetryResult|Promise\.all/);
  assert.match(page, /<InstagramObservabilityCenter/);
  assert.match(client, /catch \(caught\)/);
  assert.match(client, /setError\(\s*caught instanceof Error/);
  assert.match(client, /className=\{styles\.errorBanner\}/);
});

test('telemetria agregada possui indices para todos os recortes da janela', async () => {
  const migration = await readFile(new URL('supabase/migrations/271_optimize_publication_dispatch_telemetry.sql', root), 'utf8');
  assert.match(migration, /publication_items_dispatch_telemetry_published_idx/);
  assert.match(migration, /publication_items_dispatch_telemetry_failed_idx/);
  assert.match(migration, /publication_item_events_dispatch_telemetry_idx/);
  assert.match(migration, /publication_worker_cycles_dispatch_telemetry_idx/);
  assert.match(migration, /\(worker_kind, created_at desc\)/);
});

test('cards de incidentes permanecem contidos na coluna de prioridade', async () => {
  const css = await readFile(
    new URL('app/operacao/instagram-observability-center.module.css', root),
    'utf8',
  );

  assert.match(css, /\.contentGrid > \*,[\s\S]*?min-width: 0;/);
  assert.match(css, /\.incidentPanel[\s\S]*?overflow: hidden;/);
  assert.match(css, /\.incidentCard \{[\s\S]*?width: 100%;[\s\S]*?box-sizing: border-box;/);
  assert.match(css, /\.incidentCard h3 \{[\s\S]*?overflow-wrap: anywhere;/);
});
