import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

const read = (path: string) => readFile(new URL(path, root), "utf8");

// Incidente 29/08/2026. O commit 1eb7202 pôs `clean_publication_queue_finished`
// num laço de 10 minutos no media-maintenance-worker, e a 333 drenou o backlog
// de encerrados. As duas premissas que tornavam o arquivamento inofensivo caíram
// juntas, e três defeitos que dormiam há meses acordaram ao mesmo tempo.

test("arquivamento automático nunca leva falha que ainda pode ser reivindicada", async () => {
  const [migration, worker] = await Promise.all([
    read("supabase/migrations/335_archive_only_terminal_publication_failures.sql"),
    read("scripts/workers/media-maintenance-worker.mjs"),
  ]);

  // O predicado tem de ser exatamente o complemento do que claim_publication_items
  // aceita: se o item ainda pode ser reivindicado, arquivá-lo apaga a publicação.
  assert.match(migration, /item\.next_attempt_at is null or item\.attempt_count >= 5/);
  assert.match(migration, /item\.updated_at < settled_before/);
  assert.match(migration, /p_settled_minutes integer default 15/);

  // A assinatura antiga precisa sair do schema: o PostgREST resolve a RPC pelos
  // argumentos enviados, e worker e rota mandam só p_organization_id e p_limit —
  // com as duas vivas, cairiam na versão cega que esta migration aposenta.
  assert.match(migration, /drop function if exists public\.clean_publication_queue_finished\(uuid, integer\)/);

  // O saldo devolvido tem de usar o mesmo predicado do que foi arquivado. Se
  // contasse falha retentável, o laço do worker e o `while (remaining > 0)` do
  // hook girariam para sempre sem conseguir arquivar nada.
  const remainingBlock = migration.slice(migration.indexOf("select remaining_count + count(*)"));
  assert.match(remainingBlock, /item\.next_attempt_at is null or item\.attempt_count >= 5/);

  assert.match(worker, /clean_publication_queue_finished/);
  assert.match(worker, /falha TERMINAL/);
});

test("cancelar fila lote ou grupo não toca em item já arquivado", async () => {
  const migration = await read(
    "supabase/migrations/336_cancellation_ignores_archived_publication_items.sql",
  );

  // Os oito predicados de escopo das três funções. Arquivar não muda o status,
  // então sem este filtro um item arquivado em 'failed' continuava sendo alvo:
  // número inflado em tela, caminho fragmentado disparado à toa e, o pior,
  // sync_publication_batch_status reescrevendo o status de lotes históricos.
  const archivedFilters = migration.match(/^\s+and item_(?:inner|source)\.archived_at is null$/gm) ?? [];
  assert.equal(archivedFilters.length, 8);

  // Todo predicado de status precisa vir precedido do filtro de arquivamento.
  const statusPredicates = migration.match(/^\s+and item_(?:inner|source)\.status in \(/gm) ?? [];
  assert.equal(statusPredicates.length, 8);
  for (const match of migration.matchAll(/and (item_(?:inner|source))\.status in \(/g)) {
    const before = migration.slice(0, match.index);
    assert.match(before, new RegExp(`and ${match[1]}\\.archived_at is null\\n\\s+$`));
  }

  for (const fn of [
    "cancel_publication_queue_scope_chunk",
    "cancel_publication_queue_scope",
    "execute_server_publication_queue_cancellation",
  ]) {
    assert.match(migration, new RegExp(`create or replace function public\\.${fn}\\(`));
  }
});

test("a fila volta a contar o publicado, numa janela que o arquivo frio cobre", async () => {
  const [migration, route, client, types] = await Promise.all([
    read("supabase/migrations/337_queue_reference_keeps_recent_publication_history.sql"),
    read("app/api/publications/summary/route.ts"),
    read("app/queue/queue-client.tsx"),
    read("app/queue/publication-queue-types.ts"),
  ]);

  // A causa raiz: `archived_at is null` sozinho escondia tudo que o worker
  // arquivava 10 minutos depois de publicar.
  assert.match(migration, /item\.archived_at is null\n\s+or \(\n\s+item\.status = 'published'/);

  // O teto de 168 h é do tamanho da retenção da 333. Acima dele a linha já saiu
  // da tabela quente e a contagem viria incompleta sem nenhum erro.
  assert.match(migration, /least\(greatest\(coalesce\(p_history_hours, 24\), 1\), 168\)/);
  assert.match(route, /requestedHistoryHours < 1 \|\| requestedHistoryHours > 168/);

  // Mesma armadilha de resolução de assinatura da 335.
  assert.match(
    migration,
    /drop function if exists public\.get_publication_queue_reference_page\(uuid, text, integer, integer\)/,
  );

  // O botão de limpeza precisa de um saldo próprio: `ok` passou a incluir o
  // publicado já arquivado, que não tem mais nada a arquivar.
  assert.match(migration, /pending_archive/);
  assert.match(types, /pendingArchive\?: number/);
  assert.match(client, /queue\.summary\?\.totals\.pendingArchive \?\? 0/);
  assert.doesNotMatch(client, /totals\.ok \?\? 0\) \+ \(queue\.summary\?\.totals\.errors/);

  // Número sem unidade é o defeito anterior de outra forma: o operador precisa
  // saber de que período são as "publicadas".
  assert.match(client, /historyLabel/);
  assert.match(client, /publicadas · \{historyLabel\}/);
});
