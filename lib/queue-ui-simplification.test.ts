import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('fila Instagram mantém somente ações operacionais claras e pagina os agregados no servidor', async () => {
  const [client, hook, route, migration, scaleMigration, summaryRoute, page] = await Promise.all([
    readFile(new URL('../app/queue/queue-client.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../app/queue/use-publication-queue.ts', import.meta.url), 'utf8'),
    readFile(new URL('../app/api/publications/queue-actions/route.ts', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/migrations/258_simplify_instagram_queue_cleanup.sql', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/migrations/276_paginate_instagram_queue_reference.sql', import.meta.url), 'utf8'),
    readFile(new URL('../app/api/publications/summary/route.ts', import.meta.url), 'utf8'),
    readFile(new URL('../app/(painel)/queue/page.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(client, /Limpar encerradas/);
  assert.match(client, /refreshSummary\(tab, true\)/);
  assert.match(client, /Carregar mais/);
  assert.doesNotMatch(client, /cards\.slice\(0, displayLimit\)/);
  assert.doesNotMatch(client, /Clássico|QueueFilters|ClassicQueueList|Processar|Tirar travadas|Limpar concluídas|Limpar falhas/);
  assert.doesNotMatch(route, /dispatchPublicationQueue|release_expired_publication_leases/);
  assert.match(hook, /action: 'clean_finished'/);
  assert.match(hook, /scope, limit: String\(currentPage\.limit\), offset: String\(offset\)/);
  assert.match(summaryRoute, /get_publication_queue_reference_page/);
  assert.doesNotMatch(page, /instagram_profiles_safe|profile_group_members|zernio_connections_safe/);
  assert.match(scaleMigration, /limit least\(greatest\(coalesce\(p_limit, 25\), 1\), 100\)/);
  assert.match(scaleMigration, /publication_items_queue_profile_page_idx/);
  assert.doesNotMatch(scaleMigration, /publication_item_events|publication_item_media|createSignedUrl/);
  assert.match(migration, /clean_publication_queue_finished/);
  assert.match(migration, /status = 'failed'/);
  assert.match(migration, /archived_at = timezone\('utc', now\(\)\)/);
});

// B2.2: o número de itens aguardando arquivamento chegou a 212 mil sem ninguém
// perceber, porque só existia atrás de um botão na tela de fila. Agora fica no
// painel operacional, ao lado das outras métricas de saúde.
test("o painel operacional mostra quantos itens aguardam arquivamento", async () => {
  const [route, panel] = await Promise.all([
    readFile(new URL("../app/api/operation/observability/summary/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/operacao/instagram-observability-center.tsx", import.meta.url), "utf8"),
  ]);

  // A contagem usa exatamente os status que clean_publication_queue_finished
  // processa, senão o painel mostraria um número que o worker não drena.
  assert.match(route, /\.is\("archived_at", null\)/);
  assert.match(route, /"published", "cancelled", "removed", "ignored", "failed"/);
  assert.match(route, /pendingArchive:/);

  // Falha de medição precisa aparecer como "—", não como zero: zero significa
  // "nada esperando", que é a mensagem oposta.
  assert.match(route, /pendingArchiveResult\.error \? null :/);
  assert.match(panel, /Aguardando arquivamento/);
  assert.match(panel, /Não foi possível medir/);
});
