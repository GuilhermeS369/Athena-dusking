import { NextResponse } from "next/server";

import { getOrganizationContext } from "@/lib/organizations/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const managerRoles = new Set(["admin", "operator"]);
const activeStatuses = new Set(["pending", "running"]);

/** Um grupo por chunk: um orçamento de `statement_timeout` por grupo. */
const GROUP_LIMIT_PER_CHUNK = 1;
const TIME_BUDGET_MS = 45_000;
/**
 * Recalcular é caro e o resultado só muda quando chega métrica nova. Dez
 * minutos evitam que dois cliques seguidos (ou duas abas) refaçam a análise
 * inteira sem motivo. Não bloqueia **retomar** uma execução em andamento.
 */
const COOLDOWN_MINUTES = 10;

function noStoreJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { ...init, headers });
}

type RunRow = {
  id: string;
  status: string;
  created_at: string;
  finished_at: string | null;
  groups_total: number;
  groups_processed: number;
  groups_failed: number;
  candidates_total: number;
  latest_metric_date: string | null;
};

const runColumns =
  "id, status, created_at, finished_at, groups_total, groups_processed, groups_failed, candidates_total, latest_metric_date";

export async function GET() {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) {
    return noStoreJson({ error: "Autenticação necessária." }, { status: 401 });
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("recovery_analysis_runs")
    .select(runColumns)
    .eq("organization_id", context.activeOrganization.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return noStoreJson({ error: error.message }, { status: 500 });
  return noStoreJson({ run: data ?? null });
}

export async function POST() {
  const context = await getOrganizationContext();
  const role = context.organizations.find(
    (organization) => organization.id === context.activeOrganization?.id,
  )?.role;
  if (!context.user || !context.activeOrganization) {
    return noStoreJson({ error: "Autenticação necessária." }, { status: 401 });
  }
  if (!role || !managerRoles.has(role)) {
    return noStoreJson({ error: "Ação não permitida." }, { status: 403 });
  }

  const organizationId = context.activeOrganization.id;
  const supabase = await createSupabaseServerClient();
  const startedAt = performance.now();

  const latestResult = await supabase
    .from("recovery_analysis_runs")
    .select(runColumns)
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestResult.error) {
    return noStoreJson({ error: latestResult.error.message }, { status: 500 });
  }

  const latest = latestResult.data as RunRow | null;
  const resuming = Boolean(latest && activeStatuses.has(latest.status));

  if (!resuming && latest) {
    const minutesSince = (Date.now() - new Date(latest.created_at).getTime()) / 60_000;
    if (minutesSince < COOLDOWN_MINUTES) {
      return noStoreJson({
        error: `A análise foi refeita há menos de ${COOLDOWN_MINUTES} minutos. Aguarde para recalcular.`,
        run: latest,
        retryAfterMinutes: Math.ceil(COOLDOWN_MINUTES - minutesSince),
      }, { status: 429 });
    }
  }

  // `begin` vai pela sessão do operador de propósito: é o que grava
  // `requested_by` com o usuário real em vez do papel de serviço.
  let runId = resuming ? latest!.id : null;
  if (!runId) {
    const begun = await supabase.rpc("begin_recovery_analysis_run", {
      p_organization_id: organizationId,
      p_trigger_source: "manual",
    });
    if (begun.error) {
      return noStoreJson({ error: begun.error.message }, { status: 500 });
    }
    runId = (begun.data as { id?: string } | null)?.id ?? null;
    if (!runId) {
      return noStoreJson({ error: "A execução não devolveu identificador." }, { status: 500 });
    }
  }

  // A execução vai pelo cliente administrativo pelo mesmo motivo do
  // cancelamento de fila (app/api/publications/cancel/route.ts): a sessão do
  // navegador pode se perder no meio do polling e deixar a operação presa. A
  // rota já autenticou usuário, organização e papel.
  const executor = createSupabaseAdminClient();
  let chunks = 0;
  let remaining: number | null = null;

  while (performance.now() - startedAt < TIME_BUDGET_MS) {
    const chunk = await executor.rpc("process_recovery_analysis_chunk", {
      p_run_id: runId,
      p_group_limit: GROUP_LIMIT_PER_CHUNK,
    });
    if (chunk.error) {
      // Erro não é falha terminal: o progresso é durável e a próxima chamada
      // retoma de onde parou, exatamente como o cancelamento em blocos.
      const { data: persisted } = await supabase
        .from("recovery_analysis_runs")
        .select(runColumns)
        .eq("id", runId)
        .maybeSingle();
      return noStoreJson({ error: chunk.error.message, run: persisted ?? null }, { status: 503 });
    }
    chunks += 1;
    remaining = (chunk.data as { remaining?: number } | null)?.remaining ?? 0;
    if (remaining <= 0) break;
  }

  const finished = remaining !== null && remaining <= 0;

  if (finished) {
    const observations = await executor.rpc("refresh_recovery_cohort_observations", {
      p_organization_id: organizationId,
      p_run_id: runId,
    });
    if (observations.error) {
      console.error("recovery_recompute_observations_failed", {
        organizationId, runId, error: observations.error.message,
      });
    }
  }

  const finalResult = await supabase
    .from("recovery_analysis_runs")
    .select(runColumns)
    .eq("id", runId)
    .maybeSingle();

  return noStoreJson({
    run: finalResult.data ?? null,
    chunks,
    remaining,
    resumed: resuming,
    durationMs: Math.round(performance.now() - startedAt),
  }, { status: finished ? 200 : 202 });
}
