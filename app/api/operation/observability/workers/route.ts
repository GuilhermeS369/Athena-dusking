import { NextResponse } from "next/server";

import { instagramObservedJson } from "@/lib/instagram/api-telemetry";
import { getInstagramOperationContext } from "@/lib/instagram/request-context";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET() {
  const startedAt = performance.now();
  const stages: Record<string, number> = {};
  const auth = await getInstagramOperationContext();
  if ("response" in auth) return auth.response;
  stages.context = performance.now() - startedAt;
  const queryStartedAt = performance.now();
  const admin = createSupabaseAdminClient();
  const expectedKinds = [
    "publication",
    "publication_planner",
    "media_deletion",
    "profile_analytics",
    "zernio_sync",
  ];
  const { data, error } = await admin
    .from("publication_worker_heartbeats")
    .select(
      "worker_id,worker_kind,status,last_seen_at,last_error_message,version,hostname,process_id,started_at,dry_run,metadata",
    )
    .in("worker_kind", expectedKinds)
    .order("last_seen_at", { ascending: false });
  stages.query = performance.now() - queryStartedAt;
  if (error)
    return NextResponse.json(
      { error: "Não foi possível carregar os workers." },
      { status: 500 },
    );
  const latest = new Map<string, Record<string, unknown>>();
  for (const worker of data ?? [])
    if (!latest.has(worker.worker_kind)) latest.set(worker.worker_kind, worker);
  const workers = expectedKinds.map((kind) => {
    const raw = latest.get(kind),
      lastSeen = raw?.last_seen_at
        ? new Date(String(raw.last_seen_at)).getTime()
        : 0;
    const stale =
      !lastSeen ||
      Date.now() - lastSeen > 120_000 ||
      ["stopped", "error"].includes(String(raw?.status ?? ""));
    return {
      workerKind: kind,
      status: raw ? (stale ? "stale" : "active") : "offline",
      lastSeenAt: raw?.last_seen_at ?? null,
      lastErrorMessage: raw?.last_error_message ?? null,
      ...(auth.context.isSuperUser
        ? {
            workerId: raw?.worker_id ?? null,
            version: raw?.version ?? null,
            hostname: raw?.hostname ?? null,
            processId: raw?.process_id ?? null,
            startedAt: raw?.started_at ?? null,
            dryRun: raw?.dry_run ?? null,
            metadata: raw?.metadata ?? {},
          }
        : {}),
    };
  });
  return instagramObservedJson(
    startedAt,
    auth.context.activeOrganization.id,
    "workers",
    { workers, detailed: auth.context.isSuperUser },
    200,
    stages,
  );
}
