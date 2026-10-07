import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('limpeza de encerradas usa blocos e continua ate zerar o saldo', async () => {
  const [migration, backpressure, route, hook] = await Promise.all([
    readFile(new URL('supabase/migrations/270_fix_instagram_queue_cleanup_and_cancellation.sql', root), 'utf8'),
    readFile(new URL('supabase/migrations/302_global_heavy_workload_backpressure.sql', root), 'utf8'),
    readFile(new URL('app/api/publications/queue-actions/route.ts', root), 'utf8'),
    readFile(new URL('app/queue/use-publication-queue.ts', root), 'utf8'),
  ]);
  assert.match(migration, /p_limit integer default 2000/);
  assert.match(migration, /for update skip locked/);
  assert.match(migration, /remaining_finished_count bigint/);
  assert.match(backpressure, /least\(greatest\(coalesce\(p_limit, 250\), 1\), 250\)/);
  assert.match(backpressure, /publication_items_finished_cleanup_idx/);
  assert.match(route, /p_limit: 250/);
  assert.match(route, /acquire_operational_heavy_workload_lease/);
  assert.match(hook, /while \(remaining > 0\)/);
  assert.match(hook, /capacityWaits/);
});

test('geração limpeza e sync compartilham orçamento global sem bloquear publicação em horário', async () => {
  const [migration, generation, sync, publication] = await Promise.all([
    readFile(new URL('supabase/migrations/302_global_heavy_workload_backpressure.sql', root), 'utf8'),
    readFile(new URL('scripts/workers/publication-generation-worker.mjs', root), 'utf8'),
    readFile(new URL('scripts/workers/zernio-sync-worker.mjs', root), 'utf8'),
    readFile(new URL('scripts/workers/publication-worker.mjs', root), 'utf8'),
  ]);
  assert.match(migration, /'bulk_generation', 'queue_cleanup', 'zernio_sync'/);
  assert.match(generation, /p_category: 'bulk_generation'/);
  assert.match(sync, /p_category: 'zernio_sync'/);
  assert.doesNotMatch(publication, /acquire_operational_heavy_workload_lease/);
});

test('cancelamento por perfil grupo e lote cobre geradores e recalcula lotes afetados', async () => {
  const migration = await readFile(new URL('supabase/migrations/270_fix_instagram_queue_cleanup_and_cancellation.sql', root), 'utf8');
  assert.match(migration, /cancel_publication_queue_scope/);
  assert.match(migration, /execute_publication_queue_cancellation/);
  assert.match(migration, /sync_publication_batch_status/);
  assert.match(migration, /cancelledGenerationJobs/);
  assert.match(migration, /remainingActiveItems/);
});

// Fila de cancelamento (migration 428, 14/09/2026). Ate entao a tela guardava
// UMA operacao no navegador e so o poll da aba avancava os blocos de 1.500:
// clicar no segundo grupo abandonava o primeiro no meio.
test('a tela le a fila de cancelamento do servidor e so avanca operacao parada', async () => {
  const hook = await readFile(new URL('app/queue/use-publication-queue.ts', root), 'utf8');
  assert.match(hook, /cancellation-dismissed\.\$\{organizationId\}/);
  assert.doesNotMatch(hook, /runCancellation\(cancellationOperation, true\)/);
  assert.match(hook, /useState<QueueCancellationOperation\[\]>/);
  assert.match(hook, /CANCELLATION_STALE_STEP_MS = 15_000/);
  assert.match(hook, /cancellationExecuteInFlightRef/);
  assert.match(hook, /body: JSON\.stringify\(\{ operationId: operation\.id, execute: true \}\)/);
  // O botao da linha nao depende mais do unico `queueActionId` da pagina.
  assert.doesNotMatch(hook, /setQueueActionId\(`scope:/);
  const client = await readFile(new URL('app/queue/queue-client.tsx', root), 'utf8');
  assert.match(client, /QueueCancellationList/);
  assert.match(client, /if \(card\.tone === 'cancelled'\) return 'Cancelada';/);
  assert.match(client, /queue\.recentCompletedCancellationFor\(scope, row\.id\)/);
  const types = await readFile(new URL('app/queue/publication-queue-types.ts', root), 'utf8');
  assert.match(types, /'done' \| 'idle' \| 'cancelled'/);
});

test('migration 428: blocos sem bloqueio por item em voo, busy em vez de esperar, fontes primeiro', async () => {
  const migration = await readFile(new URL('supabase/migrations/428_publication_queue_cancellation_queue.sql', root), 'utf8');
  const chunk = migration.slice(migration.indexOf('function public.cancel_publication_queue_scope_chunk'), migration.indexOf('function public.execute_publication_queue_cancellation'));
  assert.match(chunk, /for update skip locked/);
  assert.doesNotMatch(chunk, /'chunkState', 'blocked'/);
  assert.match(chunk, /'inFlightItems', in_flight_items/);
  const executor = migration.slice(migration.indexOf('function public.execute_server_publication_queue_cancellation'), migration.indexOf('function public.refresh_publication_queue_summary'));
  assert.match(executor, /for update skip locked/);
  assert.match(executor, /'state', 'busy'/);
  assert.match(executor, /cancel_publication_queue_scope_sources\(operation_row\.scope, operation_row\.target_id\)/);
  assert.match(executor, /interval '30 minutes'/);
  assert.match(executor, /cancelable_count > 1500 or \(cancelable_count > 0 and in_flight_count > 0\)/);
  assert.match(migration, /function public.invalidate_publication_queue_summary/);
  assert.match(migration, /add column if not exists target_label text/);
});

// Migration 442 (07/10/2026). Claim abandonado: 'preparing' sem creation_id e com
// lease vencido alem do corte de atraso. O claim o exclui, a varredura nao o
// encerrava e o cancelamento em massa esperava 30 minutos por ele como "em voo"
// (11 reels presos em 06/10; dois cancelamentos da "Tia Laura 2.0" em 07/10).
test('migration 442: claim abandonado e encerrado pela varredura e cancelado pelo bloco', async () => {
  const migration = await readFile(new URL('supabase/migrations/442_abandoned_claims_close_and_cancel.sql', root), 'utf8');
  const abandoned = (alias: string) => new RegExp(
    `${alias}\\.status in \\('preparing', 'publishing'\\)\\s+and ${alias}\\.creation_id is null\\s+and \\(${alias}\\.lease_until is null or ${alias}\\.lease_until <= timezone\\('utc', now\\(\\)\\)\\)`,
    'g',
  );

  const expire = migration.slice(migration.indexOf('FUNCTION public.expire_late_publication_items'), migration.indexOf('FUNCTION public.cancel_publication_queue_scope_chunk'));
  assert.match(expire, /or item\.status = 'preparing'/);
  // As guardas que impedem tocar em item vivo continuam valendo para todos os status.
  assert.match(expire, /and item\.creation_id is null/);
  assert.match(expire, /and \(item\.lease_until is null or item\.lease_until <= timezone\('utc', now\(\)\)\)/);
  assert.match(expire, /and item\.attempt_count < 5/);

  const chunk = migration.slice(migration.indexOf('FUNCTION public.cancel_publication_queue_scope_chunk'), migration.indexOf('FUNCTION public.execute_server_publication_queue_cancellation'));
  // Candidato a cancelar + contagem de cancelaveis.
  assert.equal((chunk.match(abandoned('item_inner')) ?? []).length, 1);
  assert.equal((chunk.match(abandoned('item_source')) ?? []).length, 1);
  assert.match(chunk, /for update skip locked/);

  const executor = migration.slice(migration.indexOf('FUNCTION public.execute_server_publication_queue_cancellation'));
  // Contagem de cancelaveis + contagem de abandonados.
  assert.equal((executor.match(abandoned('item_source')) ?? []).length, 2);
  assert.match(executor, /into cancelable_count, in_flight_count, abandoned_count/);
  assert.match(executor, /cancelable_count > 1500 or \(cancelable_count > 0 and \(in_flight_count > 0 or abandoned_count > 0\)\)/);
  assert.match(executor, /interval '30 minutes'/);

  // Em voo e so o item com lease vigente ou com conteiner: nas duas funcoes.
  for (const body of [chunk, executor]) {
    assert.match(body, /item_source\.status in \('preparing', 'publishing'\)\s+and not \(\s+item_source\.creation_id is null\s+and \(item_source\.lease_until is null or item_source\.lease_until <= timezone\('utc', now\(\)\)\)\s+\)/);
  }
});

test('migration 428: a passada compacta ignora arquivados e nao mexe nos lotes da organizacao inteira', async () => {
  const migration = await readFile(new URL('supabase/migrations/428_publication_queue_cancellation_queue.sql', root), 'utf8');
  const compact = migration.slice(migration.indexOf('function public.execute_publication_queue_cancellation'), migration.indexOf('function public.execute_server_publication_queue_cancellation'));
  // Os dois predicados de escopo (cursor de trava e update final) filtram arquivados.
  assert.equal((compact.match(/item_source\.archived_at is null/g) ?? []).length, 2);
  assert.doesNotMatch(compact, /update public\.publication_batches batch_row\s+set status = 'cancelled'/);
});

test('migration 428: o resumo tem o tom cancelled e mantem a linha do alvo cancelado na janela', async () => {
  const migration = await readFile(new URL('supabase/migrations/428_publication_queue_cancellation_queue.sql', root), 'utf8');
  const refresh = migration.slice(migration.indexOf('function public.refresh_publication_queue_summary'));
  assert.match(refresh, /when a\.active = 0 and \(r\.row_id is not null or \(a\.closed > 0 and a\.completed = 0\)\) then 'cancelled'/);
  assert.match(refresh, /where a\.total > 0 or r\.row_id is not null/);
  assert.match(refresh, /operation\.completed_at >= cutoff/);
});

test('rota de cancelamento: orcamento de 30 s, lista limitada, avanco por operationId e invalidacao do resumo', async () => {
  const route = await readFile(new URL('app/api/publications/cancel/route.ts', root), 'utf8');
  assert.match(route, /export const maxDuration = 30;/);
  assert.match(route, /RECENT_OPERATIONS_LIMIT = 50/);
  assert.match(route, /\.limit\(RECENT_OPERATIONS_LIMIT\)/);
  assert.match(route, /typeof body\.operationId === 'string'/);
  assert.match(route, /rpc\('invalidate_publication_queue_summary'/);
  assert.match(route, /state === 'busy'/);
});

test('worker de cancelamento: serial, limitado, registrado no package.json e no PM2', async () => {
  const [worker, packageJson, ecosystem] = await Promise.all([
    readFile(new URL('scripts/workers/publication-cancellation-worker.mjs', root), 'utf8'),
    readFile(new URL('package.json', root), 'utf8'),
    readFile(new URL('deploy/instagram/ecosystem.config.cjs', root), 'utf8'),
  ]);
  assert.match(worker, /\.eq\('status', 'running'\)/);
  assert.match(worker, /\.order\('updated_at', \{ ascending: true \}\)\s*\.order\('id', \{ ascending: true \}\)/);
  assert.match(worker, /\.limit\(maxOperations\)/);
  assert.match(worker, /'PUBLICATION_CANCELLATION_WORKER_MAX_OPERATIONS', 20, 1, 100/);
  assert.match(worker, /for \(const op of operacoes\)/);
  assert.match(worker, /tickBudgetMs/);
  assert.match(worker, /rpc\('execute_server_publication_queue_cancellation'/);
  assert.match(worker, /rpc\('invalidate_publication_queue_summary'/);
  assert.match(packageJson, /"worker:publication-cancellation": "node scripts\/workers\/publication-cancellation-worker\.mjs"/);
  assert.match(ecosystem, /npmWorker\('athena-cancellation-worker', 'worker:publication-cancellation'\)/);
});
