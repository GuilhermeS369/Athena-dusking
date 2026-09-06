import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * Janela de retenção dos logs, em dias.
 *
 * Era 14 e passou a 7 em 05/09/2026, quando o banco chegou a ~15 GB vindo de
 * ~600 MB em duas semanas. Metade disso é log: `instagram_observability_events`
 * sozinha guardava 2,66 milhões de linhas em 13 índices, e a fatia com mais de 7
 * dias eram ~570 mil.
 *
 * Sete e não cinco porque o piso combinado é cinco dias de histórico — e um piso
 * sem folga vira teto no primeiro dia em que a manutenção falhar. O piso mora no
 * clamp das funções da 401: nenhum chamador consegue pedir menos que isso.
 */
const RETENTION_DAYS = 7;

const HOT_DAILY_SOURCES = [
  "partitions", "default_events", "event_rollups", "worker_rollups",
  "incident_actions", "incident_entities", "resolved_incidents",
] as const;
const LEGACY_SOURCES = [
  "publication_events", "worker_cycles", "sync_logs",
  "request_anomalies", "request_rollups",
  "media_delivery_attempts", "analytics_step_events",
  "analytics_item_events", "batch_terminal_outcomes",
] as const;

function authorized(request: Request) {
  const expected = process.env.PUBLICATION_WORKER_SECRET;
  const received = request.headers.get("x-worker-secret") ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || !received) return false;
  const expectedBuffer = Buffer.from(expected), receivedBuffer = Buffer.from(received);
  return expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer);
}

export async function POST(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
  const admin = createSupabaseAdminClient();
  const startedAt = performance.now();
  const body = await request.json().catch(() => ({})) as {
    mode?: unknown;
    kind?: unknown;
    source?: unknown;
  };

  const pressureResult = await admin.rpc(
    "get_publication_generation_pressure_signal",
    { p_critical_delay_seconds: 60 },
  );
  if (pressureResult.error) {
    return NextResponse.json(
      { ok: false, error: pressureResult.error.message, source: "publication_pressure" },
      { status: 503 },
    );
  }
  if (pressureResult.data?.criticalDelay === true) {
    return NextResponse.json({
      ok: true,
      paused: true,
      reason: "critical_publication_delay",
      pressure: pressureResult.data,
      checkedAt: new Date().toISOString(),
    }, { status: 202 });
  }

  if (body.mode === "source") {
    const source = typeof body.source === "string" ? body.source : "";
    const kind = body.kind === "hot" || body.kind === "legacy" ? body.kind : null;
    const allowed = kind === "hot"
      ? HOT_DAILY_SOURCES.includes(source as (typeof HOT_DAILY_SOURCES)[number])
      : kind === "legacy"
        ? LEGACY_SOURCES.includes(source as (typeof LEGACY_SOURCES)[number])
        : false;
    if (!kind || !allowed)
      return NextResponse.json({ error: "Fonte de manutenção inválida." }, { status: 400 });

    const rpc = kind === "hot"
      ? "maintain_instagram_observability_hot_source"
      : "maintain_instagram_legacy_log_retention_source";
    let attempts = 0;
    let result;
    for (const batchSize of [500, 100]) {
      attempts += 1;
      result = await admin.rpc(rpc, {
        p_source: source,
        p_retention_days: RETENTION_DAYS,
        p_batch_size: batchSize,
      });
      if (!result.error) break;
    }
    const response = {
      ok: !result?.error,
      mode: "source",
      kind,
      source,
      attempts,
      result: result?.data ?? null,
      durationMs: Math.round(performance.now() - startedAt),
      checkedAt: new Date().toISOString(),
      ...(result?.error ? { error: result.error.message } : {}),
    };
    if (result?.error) {
      console.error("instagram_observability_source_maintenance_failed", response);
      return NextResponse.json(response, { status: 500 });
    }
    console.info("instagram_observability_source_maintenance_succeeded", response);
    return NextResponse.json(response);
  }

  if (body.mode != null && body.mode !== "frequent")
    return NextResponse.json({ error: "Modo de manutenção inválido." }, { status: 400 });

  const failures: Array<{ source: string; error: string }> = [];
  const apiMetricsResult = await admin.rpc("instagram_purge_observability_api_metrics", {
    p_retention_days: RETENTION_DAYS,
  });
  const boundaryResult = await admin.rpc("maintain_instagram_observability_hot_source", {
    p_source: "boundary_events",
    p_retention_days: RETENTION_DAYS,
    p_batch_size: 500,
  });
  const rollupResult = await admin.rpc("refresh_instagram_observability_rollups_recent", {
    p_lookback_minutes: 20,
  });
  const summarySnapshotResult = await admin.rpc(
    "refresh_instagram_observability_summary_snapshots",
  );
  const queueSnapshotResult = await admin.rpc(
    "refresh_publication_queue_operational_snapshots",
  );
  const dispatchStateSnapshotResult = await admin.rpc(
    "refresh_publication_dispatch_state_snapshots",
  );
  if (apiMetricsResult.error) failures.push({ source: "api_metrics", error: apiMetricsResult.error.message });
  if (boundaryResult.error) failures.push({ source: "boundary_events", error: boundaryResult.error.message });
  if (rollupResult.error) failures.push({ source: "recent_rollups", error: rollupResult.error.message });
  if (summarySnapshotResult.error)
    failures.push({ source: "summary_snapshots", error: summarySnapshotResult.error.message });
  if (queueSnapshotResult.error)
    failures.push({ source: "queue_snapshots", error: queueSnapshotResult.error.message });
  if (dispatchStateSnapshotResult.error)
    failures.push({ source: "dispatch_state_snapshots", error: dispatchStateSnapshotResult.error.message });
  const response = {
    ok: failures.length === 0,
    mode: "frequent",
    boundary: boundaryResult.data ?? null,
    recentRollups: rollupResult.data ?? null,
    summarySnapshotsRefreshed: summarySnapshotResult.data ?? null,
    queueSnapshotsRefreshed: queueSnapshotResult.data ?? null,
    dispatchStateSnapshotsRefreshed: dispatchStateSnapshotResult.data ?? null,
    apiMetricsDeleted: apiMetricsResult.data ?? null,
    failures,
    durationMs: Math.round(performance.now() - startedAt),
    checkedAt: new Date().toISOString(),
  };
  if (failures.length) {
    console.error("instagram_observability_maintenance_failed", response);
    return NextResponse.json(
      { ...response, error: "Falha parcial na manutenção dos logs Instagram." },
      { status: 500 },
    );
  }
  console.info("instagram_observability_maintenance_succeeded", response);
  return NextResponse.json(response);
}
