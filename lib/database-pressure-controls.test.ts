import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const zernioWorkerUrl = new URL(
  "../scripts/workers/zernio-sync-worker.mjs",
  import.meta.url,
);
const maintenanceRouteUrl = new URL(
  "../app/api/internal/instagram-observability-maintenance/route.ts",
  import.meta.url,
);
const boundedMaintenanceMigrationUrl = new URL(
  "../supabase/migrations/305_bound_zernio_media_maintenance_batches.sql",
  import.meta.url,
);
const analyticsWorkerUrl = new URL(
  "../scripts/workers/profile-analytics-direct-worker.ts",
  import.meta.url,
);
const analyticsRouteUrl = new URL(
  "../app/api/internal/profile-analytics-refresh-dispatch/route.ts",
  import.meta.url,
);
const queueActionsRouteUrl = new URL(
  "../app/api/publications/queue-actions/route.ts",
  import.meta.url,
);
const consolidatedDeferMigrationUrl = new URL(
  "../supabase/migrations/306_consolidate_repeated_publication_defer_events.sql",
  import.meta.url,
);
const mediaMaintenanceRouteUrl = new URL(
  "../app/api/internal/media-deletion-dispatch/route.ts",
  import.meta.url,
);

test("sync Zernio consulta pressão uma vez por minuto antes do lease pesado", async () => {
  const source = await readFile(zernioWorkerUrl, "utf8");
  const pressureIndex = source.indexOf("get_publication_generation_pressure_signal");
  const leaseIndex = source.indexOf("acquire_operational_heavy_workload_lease");

  assert.notEqual(pressureIndex, -1);
  assert.notEqual(leaseIndex, -1);
  assert.ok(pressureIndex < leaseIndex, "pressão deve ser verificada antes do lease pesado");
  assert.match(source, /Date\.now\(\) - lastPressureCheckAt >= 60_000/);
  assert.match(source, /waitingForPublicationCapacity: true/);
});

test("manutenção de observabilidade pausa antes das RPCs pesadas", async () => {
  const source = await readFile(maintenanceRouteUrl, "utf8");
  const pressureIndex = source.indexOf("get_publication_generation_pressure_signal");
  const retentionIndex = source.indexOf("instagram_purge_observability_api_metrics");

  assert.notEqual(pressureIndex, -1);
  assert.notEqual(retentionIndex, -1);
  assert.ok(pressureIndex < retentionIndex, "gate deve anteceder retenção e rollups");
  assert.match(source, /reason: "critical_publication_delay"/);
  assert.match(source, /status: 202/);
});

test("manutenção Zernio preserva contratos e limita o lote efetivo", async () => {
  const migration = await readFile(boundedMaintenanceMigrationUrl, "utf8");

  assert.match(migration, /effective_limit := least\(p_limit, 100\)/);
  assert.match(migration, /effective_limit := least\(p_limit, 250\)/);
  assert.match(migration, /and item\.preparation_status = 'ready'/);
  assert.match(migration, /and item\.preparation_status = 'pending'/);
  assert.match(migration, /for update of item skip locked/gi);
});

test("analytics direto e fallback pausam quando a publicação está atrasada", async () => {
  const [worker, route] = await Promise.all([
    readFile(analyticsWorkerUrl, "utf8"),
    readFile(analyticsRouteUrl, "utf8"),
  ]);

  assert.match(worker, /get_publication_generation_pressure_signal/);
  assert.match(worker, /Date\.now\(\) - lastPressureCheckAt >= 60_000/);
  assert.match(worker, /reason: 'critical_publication_delay'/);
  assert.match(route, /get_publication_generation_pressure_signal/);
  assert.match(route, /status: 202/);
});

test("ações de limpeza são bloqueadas antes de reservar capacidade", async () => {
  const route = await readFile(queueActionsRouteUrl, "utf8");
  const gateIndex = route.indexOf("publicationPressureResponse('clean_finished')");
  const leaseIndex = route.indexOf("acquire_operational_heavy_workload_lease");

  assert.notEqual(gateIndex, -1);
  assert.notEqual(leaseIndex, -1);
  assert.ok(gateIndex < leaseIndex, "gate de pressão deve anteceder o lease da limpeza");
  assert.match(route, /retryAfterSeconds: 60/);
});

test("defer mantém estado em todo poll e consolida somente o evento redundante", async () => {
  const migration = await readFile(consolidatedDeferMigrationUrl, "utf8");

  assert.match(migration, /when p_is_poll then item\.container_poll_count \+ 1/);
  assert.match(migration, /next_attempt_at = now_at \+ make_interval/);
  assert.match(migration, /item_row\.container_poll_count = 0/);
  assert.match(migration, /updated_row\.container_poll_count % 5 = 0/);
  assert.match(migration, /perform public\.log_publication_item_event/);
});

test("manutenção de mídia pausa antes de reivindicar exclusão ou grupos", async () => {
  const route = await readFile(mediaMaintenanceRouteUrl, "utf8");
  const pressureIndex = route.indexOf("get_publication_generation_pressure_signal");
  const dispatchIndex = route.indexOf("dispatchMediaDeletionJobs({");

  assert.notEqual(pressureIndex, -1);
  assert.notEqual(dispatchIndex, -1);
  assert.ok(pressureIndex < dispatchIndex, "gate deve anteceder os dois dispatchers de mídia");
  assert.match(route, /reason: 'critical_publication_delay'/);
  assert.match(route, /status: 202/);
});

test("modo de reconciliação do publicador não cria novo trabalho no provedor", async () => {
  const [dispatcher, worker] = await Promise.all([
    readFile(new URL("../scripts/workers/publication-direct-dispatch.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/workers/publication-worker.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(worker, /PUBLICATION_WORKER_RECONCILIATION_ONLY/);
  assert.match(dispatcher, /claim_provider_accepted_publication_items/);
  // A preparação passou a poder ser pulada também quando roda em laço próprio
  // (skipPreparation), mas `reconciliationOnly` continua sendo condição
  // suficiente para não criar trabalho novo — que é o que este teste protege.
  assert.match(dispatcher, /reconciliationOnly \|\| options\.skipPreparation === true/);
  assert.match(dispatcher, /\{ claimed: 0, ready: 0, blocked: 0, errors: 0, results: \[\] \}/);
  assert.match(dispatcher, /reconciliationOnly \? \[\] : await claimCoordinatedBulkSlotRecoveryItems/);
  assert.match(dispatcher, /reconciliationOnly \? \[\] : await processZernioProfileRecyclingJobs/);
});
