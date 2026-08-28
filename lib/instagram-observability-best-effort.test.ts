import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../supabase/migrations/286_harden_instagram_observability_best_effort.sql",
  import.meta.url,
);

test("projeções Instagram tipam enums e isolam falhas de observabilidade", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  const functions = [
    "project_publication_item_event_to_instagram_observability",
    "project_zernio_sync_log_to_instagram_observability",
    "project_zernio_disconnection_to_instagram_observability",
    "project_zernio_request_anomaly_to_instagram_observability",
  ];

  for (const [index, functionName] of functions.entries()) {
    const start = migration.indexOf(`create or replace function public.${functionName}()`);
    assert.notEqual(start, -1, `${functionName} deve ser substituída`);
    const nextStart = index + 1 < functions.length
      ? migration.indexOf(`create or replace function public.${functions[index + 1]}()`, start)
      : migration.indexOf("revoke all on function", start);
    const definition = migration.slice(start, nextStart);
    assert.match(definition, /exception when others/i, `${functionName} deve ser best-effort`);
    assert.match(definition, /return new;/i, `${functionName} deve preservar a origem autoritativa`);
  }

  assert.match(migration, /::public\.instagram_observability_domain/);
  assert.match(migration, /::public\.instagram_observability_severity/);
  assert.match(migration, /::public\.instagram_observability_treatment/);
});

test("migration não reenfileira nem modifica publicações afetadas", async () => {
  const migration = await readFile(migrationUrl, "utf8");

  assert.doesNotMatch(migration, /update\s+public\.publication_items/i);
  assert.doesNotMatch(migration, /next_attempt_at\s*=/i);
  assert.doesNotMatch(migration, /creation_id\s*=/i);
  assert.doesNotMatch(migration, /attempt_count\s*=/i);
  assert.doesNotMatch(migration, /\b(requeue|retry_publication|claim_publication_items)\b/i);
});
