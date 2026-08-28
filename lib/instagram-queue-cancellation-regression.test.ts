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

test('operacao duravel e isolada por organizacao e retomada idempotentemente', async () => {
  const hook = await readFile(new URL('app/queue/use-publication-queue.ts', root), 'utf8');
  assert.match(hook, /cancellation-operation\.\$\{organizationId\}/);
  assert.match(hook, /runCancellation\(cancellationOperation, true\)/);
});
