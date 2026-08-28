import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getTwitterRequestContext } from "@/lib/twitter/request-context";
import { summarizeTwitterWorkers, TWITTER_WORKER_NAMES } from "@/lib/twitter/rollout-health";

export const dynamic = "force-dynamic";

type SummaryCounts = {
  open: number; investigating: number; critical: number;
  account: number; scheduling: number; publication: number; worker: number;
  connection: number; analytics: number; finance: number;
  events24h: number;
};

const COUNT_KEYS = ["open", "investigating", "critical", "account", "scheduling", "publication", "worker", "connection", "analytics", "finance", "events24h"] as const;

// Avisa uma vez por instância, e não a cada poll de 30 s por aba aberta.
let warnedAboutFallback = false;

async function count(query: PromiseLike<{ count: number | null; error: { message: string } | null }>) {
  const result = await query;
  if (result.error) throw new Error(result.error.message);
  return result.count ?? 0;
}

/** Caminho preferido: uma varredura por tabela (migration 316). */
async function countsViaRpc(admin: SupabaseClient, organizationId: string, since: string): Promise<SummaryCounts | null> {
  const { data, error } = await admin.rpc("twitter_observability_summary_counts", {
    p_organization_id: organizationId,
    p_events_since: since,
  });
  if (error || !data || typeof data !== "object") return null;
  const row = data as Record<string, unknown>;
  const parsed = Object.fromEntries(COUNT_KEYS.map((key) => [key, Number(row[key] ?? 0)])) as SummaryCounts;
  // Um valor não numérico indica contrato diferente do esperado: cai para o
  // caminho antigo em vez de exibir métrica silenciosamente errada.
  return COUNT_KEYS.every((key) => Number.isFinite(parsed[key])) ? parsed : null;
}

/**
 * Caminho legado: 11 count(exact) separados. Mantido apenas para que a rota
 * possa ser deployada antes da migration 316 ser aplicada.
 */
async function countsViaScans(admin: SupabaseClient, organizationId: string, since: string): Promise<SummaryCounts> {
  const openIncidents = () => admin.from("twitter_observability_incidents").select("*", { count: "exact", head: true }).eq("organization_id", organizationId).neq("status", "resolved");
  const [open, investigating, critical, account, scheduling, publication, worker, connection, analytics, finance, events24h] = await Promise.all([
    count(admin.from("twitter_observability_incidents").select("*", { count: "exact", head: true }).eq("organization_id", organizationId).eq("status", "open")),
    count(admin.from("twitter_observability_incidents").select("*", { count: "exact", head: true }).eq("organization_id", organizationId).eq("status", "investigating")),
    count(openIncidents().eq("severity", "critical")),
    count(openIncidents().eq("domain", "account")),
    count(openIncidents().eq("domain", "scheduling")),
    count(openIncidents().eq("domain", "publication")),
    count(openIncidents().eq("domain", "worker")),
    count(openIncidents().eq("domain", "connection")),
    count(openIncidents().eq("domain", "analytics")),
    count(openIncidents().eq("domain", "finance")),
    count(admin.from("twitter_observability_events").select("*", { count: "exact", head: true }).eq("organization_id", organizationId).gte("occurred_at", since)),
  ]);
  return { open, investigating, critical, account, scheduling, publication, worker, connection, analytics, finance, events24h };
}

export async function GET() {
  const auth = await getTwitterRequestContext();
  if ("response" in auth) return auth.response;
  const admin = createSupabaseAdminClient();
  const organizationId = auth.context.activeOrganization.id;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
  try {
    const [counts, heartbeatResult, breakerResult] = await Promise.all([
      countsViaRpc(admin, organizationId, since).then(async (viaRpc) => {
        if (viaRpc) return viaRpc;
        if (!warnedAboutFallback) {
          warnedAboutFallback = true;
          console.warn("[twitter-observability-summary] migration 316 indisponível; usando o caminho antigo de 11 count(exact).");
        }
        return countsViaScans(admin, organizationId, since);
      }),
      admin.from("twitter_worker_heartbeats").select("worker_name,mode,last_seen_at").in("worker_name", [...TWITTER_WORKER_NAMES]),
      admin.from("twitter_circuit_breakers").select("scope_key,state,failure_count,reason,updated_at").like("scope_key", "worker:athena-twitter-%"),
    ]);
    if (heartbeatResult.error || breakerResult.error) throw new Error(heartbeatResult.error?.message ?? breakerResult.error?.message);
    const workerEntries = summarizeTwitterWorkers(heartbeatResult.data ?? [], process.env, Date.now(), 120);
    return NextResponse.json({
      incidents: {
        open: counts.open,
        investigating: counts.investigating,
        critical: counts.critical,
        byDomain: {
          account: counts.account, scheduling: counts.scheduling, publication: counts.publication,
          worker: counts.worker, connection: counts.connection, analytics: counts.analytics, finance: counts.finance,
        },
      },
      events24h: counts.events24h,
      workers: { entries: workerEntries, stale: workerEntries.filter((entry) => entry.state === "stale").length },
      circuitBreakers: { entries: breakerResult.data ?? [], open: (breakerResult.data ?? []).filter((entry) => entry.state !== "closed").length },
      checkedAt: new Date().toISOString(),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[twitter-observability-summary]", { organizationId, message: error instanceof Error ? error.message : "Falha desconhecida" });
    return NextResponse.json({ error: "Não foi possível carregar o resumo operacional X." }, { status: 500 });
  }
}
