import { NextResponse } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getTwitterRequestContext } from "@/lib/twitter/request-context";
import { summarizeTwitterWorkers, TWITTER_WORKER_NAMES } from "@/lib/twitter/rollout-health";

export const dynamic = "force-dynamic";

async function count(query: PromiseLike<{ count: number | null; error: { message: string } | null }>) {
  const result = await query;
  if (result.error) throw new Error(result.error.message);
  return result.count ?? 0;
}

export async function GET() {
  const auth = await getTwitterRequestContext();
  if ("response" in auth) return auth.response;
  const admin = createSupabaseAdminClient();
  const organizationId = auth.context.activeOrganization.id;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
  try {
    const [open, investigating, critical, accounts, scheduling, publication, workers, connections, analytics, finance, events24h, heartbeatResult, breakerResult] = await Promise.all([
      count(admin.from("twitter_observability_incidents").select("*", { count: "exact", head: true }).eq("organization_id", organizationId).eq("status", "open")),
      count(admin.from("twitter_observability_incidents").select("*", { count: "exact", head: true }).eq("organization_id", organizationId).eq("status", "investigating")),
      count(admin.from("twitter_observability_incidents").select("*", { count: "exact", head: true }).eq("organization_id", organizationId).neq("status", "resolved").eq("severity", "critical")),
      count(admin.from("twitter_observability_incidents").select("*", { count: "exact", head: true }).eq("organization_id", organizationId).neq("status", "resolved").eq("domain", "account")),
      count(admin.from("twitter_observability_incidents").select("*", { count: "exact", head: true }).eq("organization_id", organizationId).neq("status", "resolved").eq("domain", "scheduling")),
      count(admin.from("twitter_observability_incidents").select("*", { count: "exact", head: true }).eq("organization_id", organizationId).neq("status", "resolved").eq("domain", "publication")),
      count(admin.from("twitter_observability_incidents").select("*", { count: "exact", head: true }).eq("organization_id", organizationId).neq("status", "resolved").eq("domain", "worker")),
      count(admin.from("twitter_observability_incidents").select("*", { count: "exact", head: true }).eq("organization_id", organizationId).neq("status", "resolved").eq("domain", "connection")),
      count(admin.from("twitter_observability_incidents").select("*", { count: "exact", head: true }).eq("organization_id", organizationId).neq("status", "resolved").eq("domain", "analytics")),
      count(admin.from("twitter_observability_incidents").select("*", { count: "exact", head: true }).eq("organization_id", organizationId).neq("status", "resolved").eq("domain", "finance")),
      count(admin.from("twitter_observability_events").select("*", { count: "exact", head: true }).eq("organization_id", organizationId).gte("occurred_at", since)),
      admin.from("twitter_worker_heartbeats").select("worker_name,mode,last_seen_at").in("worker_name", [...TWITTER_WORKER_NAMES]),
      admin.from("twitter_circuit_breakers").select("scope_key,state,failure_count,reason,updated_at").like("scope_key", "worker:athena-twitter-%"),
    ]);
    if (heartbeatResult.error || breakerResult.error) throw new Error(heartbeatResult.error?.message ?? breakerResult.error?.message);
    const workerEntries = summarizeTwitterWorkers(heartbeatResult.data ?? [], process.env, Date.now(), 120);
    return NextResponse.json({
      incidents: { open, investigating, critical, byDomain: { account: accounts, scheduling, publication, worker: workers, connection: connections, analytics, finance } },
      events24h,
      workers: { entries: workerEntries, stale: workerEntries.filter((entry) => entry.state === "stale").length },
      circuitBreakers: { entries: breakerResult.data ?? [], open: (breakerResult.data ?? []).filter((entry) => entry.state !== "closed").length },
      checkedAt: new Date().toISOString(),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[twitter-observability-summary]", { organizationId, message: error instanceof Error ? error.message : "Falha desconhecida" });
    return NextResponse.json({ error: "Não foi possível carregar o resumo operacional X." }, { status: 500 });
  }
}

