import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Despacho da análise de recuperação.
 *
 * O formato é ditado pelo `statement_timeout` de ~8s do papel do PostgREST: a
 * RPC processa **um grupo por chamada** e devolve `remaining`, e o laço vive
 * aqui, entre chamadas. Um `for` em plpgsql percorrendo doze grupos gastaria o
 * mesmo orçamento de um statement gigante — foi a lição da migration 324.
 *
 * Uma invocação percorre **todas** as organizações que precisam de trabalho,
 * dentro de um orçamento de tempo — é o que permite o mesmo endpoint servir ao
 * cron da Vercel (um disparo só) e ao laço do cron da VPS (várias chamadas).
 * Se o orçamento acabar no meio, o progresso é durável e a chamada seguinte
 * retoma exatamente de onde parou; `done: false` avisa que ainda há trabalho.
 */

/** Um grupo por chunk: é o que garante um orçamento de timeout por grupo. */
const GROUP_LIMIT_PER_CHUNK = 1;
/** Deixa folga contra o `maxDuration` de 60s para a resposta sempre sair. */
const TIME_BUDGET_MS = 45_000;
/**
 * A análise é diária. Sem isto, o cron de cinco em cinco minutos abriria uma
 * execução nova a cada passada — e a comparação "novos elegíveis desde ontem"
 * viraria "desde cinco minutos atrás", que não informa nada.
 */
const MIN_HOURS_BETWEEN_RUNS = 20;

const ACTIVE_STATUSES = ["pending", "running"] as const;

function authorized(request: Request) {
  const received = request.headers.get("x-worker-secret")
    ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!received) return false;
  const candidates = [
    process.env.RECOVERY_ANALYSIS_WORKER_SECRET,
    process.env.PUBLICATION_WORKER_SECRET,
    process.env.CRON_SECRET,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  const receivedBuffer = Buffer.from(received);
  return candidates.some((expected) => {
    const expectedBuffer = Buffer.from(expected);
    return expectedBuffer.length === receivedBuffer.length
      && timingSafeEqual(expectedBuffer, receivedBuffer);
  });
}

type RunRow = {
  id: string;
  status: string;
  created_at: string;
  finished_at: string | null;
};

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
  }

  const admin = createSupabaseAdminClient();
  const startedAt = performance.now();
  const body = await request.json().catch(() => ({})) as {
    organizationId?: unknown;
    force?: unknown;
  };
  const requestedOrganizationId = typeof body.organizationId === "string" ? body.organizationId : null;
  const force = body.force === true;

  // A análise nunca disputa banco com a fila de publicação. Mesmo portão dos
  // outros despachantes internos: sob pressão crítica, sai sem trabalhar.
  const pressure = await admin.rpc("get_publication_generation_pressure_signal", {
    p_critical_delay_seconds: 60,
  });
  if (pressure.error) {
    return NextResponse.json(
      { ok: false, error: pressure.error.message, source: "publication_pressure" },
      { status: 503 },
    );
  }
  if (pressure.data?.criticalDelay === true) {
    return NextResponse.json({
      ok: true,
      done: false,
      paused: true,
      reason: "critical_publication_delay",
      pressure: pressure.data,
      checkedAt: new Date().toISOString(),
    }, { status: 202 });
  }

  // Organizações com ao menos um grupo liberado para a tela. `profile_groups`
  // não escala com o tamanho da organização (são dezenas de grupos), então o
  // teto de mil linhas é folgado e honesto.
  const groupsResult = await admin
    .from("profile_groups")
    .select("organization_id")
    .eq("recovery_enabled", true)
    .is("recovery_source_group_id", null)
    .is("deleted_at", null)
    .limit(1000);
  if (groupsResult.error) {
    return NextResponse.json(
      { ok: false, error: groupsResult.error.message, source: "recovery_groups" },
      { status: 500 },
    );
  }

  const organizationIds = [...new Set((groupsResult.data ?? []).map((row) => row.organization_id))]
    .filter((id): id is string => typeof id === "string")
    .filter((id) => !requestedOrganizationId || id === requestedOrganizationId)
    .sort();

  if (!organizationIds.length) {
    return NextResponse.json({
      ok: true,
      done: true,
      reason: "no_enabled_groups",
      durationMs: Math.round(performance.now() - startedAt),
      checkedAt: new Date().toISOString(),
    });
  }

  // Percorre as organizações que precisam de trabalho, dentro de um orçamento
  // de tempo. Uma invocação basta para o caso comum; se o orçamento acabar, o
  // progresso é durável e a próxima chamada retoma exatamente daqui — que é o
  // que permite o mesmo endpoint servir ao cron da Vercel (um disparo) e ao
  // laço do cron da VPS (várias chamadas).
  const pending: string[] = [];
  const resumable = new Map<string, string>();

  for (const organizationId of organizationIds) {
    const runResult = await admin
      .from("recovery_analysis_runs")
      .select("id, status, created_at, finished_at")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (runResult.error) {
      return NextResponse.json(
        { ok: false, organizationId, error: runResult.error.message, source: "recovery_runs" },
        { status: 500 },
      );
    }

    const latest = runResult.data as RunRow | null;
    const isActive = latest
      ? ACTIVE_STATUSES.includes(latest.status as typeof ACTIVE_STATUSES[number])
      : false;
    const hoursSince = latest
      ? (Date.now() - new Date(latest.finished_at ?? latest.created_at).getTime()) / 3_600_000
      : Number.POSITIVE_INFINITY;

    if (isActive) {
      pending.push(organizationId);
      resumable.set(organizationId, latest!.id);
    } else if (force || hoursSince >= MIN_HOURS_BETWEEN_RUNS) {
      pending.push(organizationId);
    }
  }

  if (!pending.length) {
    return NextResponse.json({
      ok: true,
      done: true,
      reason: "up_to_date",
      organizations: organizationIds.length,
      durationMs: Math.round(performance.now() - startedAt),
      checkedAt: new Date().toISOString(),
    });
  }

  const results: Array<Record<string, unknown>> = [];
  const failures: Array<{ source: string; error: string }> = [];
  let processedOrganizations = 0;

  for (const organizationId of pending) {
    if (performance.now() - startedAt >= TIME_BUDGET_MS) break;

    let runId = resumable.get(organizationId) ?? null;
    if (!runId) {
      const begun = await admin.rpc("begin_recovery_analysis_run", {
        p_organization_id: organizationId,
        p_trigger_source: "cron",
      });
      if (begun.error) {
        failures.push({ source: `begin_run:${organizationId}`, error: begun.error.message });
        continue;
      }
      runId = (begun.data as { id?: string } | null)?.id ?? null;
      if (!runId) {
        failures.push({ source: `begin_run:${organizationId}`, error: "sem identificador de execução" });
        continue;
      }
    }

    let chunks = 0;
    let processed = 0;
    let failed = 0;
    let remaining: number | null = null;

    while (performance.now() - startedAt < TIME_BUDGET_MS) {
      const chunk = await admin.rpc("process_recovery_analysis_chunk", {
        p_run_id: runId,
        p_group_limit: GROUP_LIMIT_PER_CHUNK,
      });
      if (chunk.error) {
        failures.push({ source: `process_chunk:${organizationId}`, error: chunk.error.message });
        break;
      }
      const data = chunk.data as {
        processed?: number; failed?: number; remaining?: number;
      } | null;
      chunks += 1;
      processed += data?.processed ?? 0;
      failed += data?.failed ?? 0;
      remaining = data?.remaining ?? 0;
      if (remaining <= 0) break;
    }

    const finished = remaining !== null && remaining <= 0;
    let observationsRefreshed: number | null = null;
    let prunedRuns: number | null = null;

    if (finished) {
      // O acompanhamento da coorte roda depois dos grupos, na mesma passada: é
      // ele que alimenta a aba "Em recuperação" sem cálculo na renderização.
      const observations = await admin.rpc("refresh_recovery_cohort_observations", {
        p_organization_id: organizationId,
        p_run_id: runId,
      });
      if (observations.error) {
        failures.push({ source: `cohort_observations:${organizationId}`, error: observations.error.message });
      } else {
        observationsRefreshed = observations.data as number;
      }

      const pruned = await admin.rpc("prune_recovery_analysis_runs", {
        p_organization_id: organizationId,
      });
      if (pruned.error) failures.push({ source: `prune_runs:${organizationId}`, error: pruned.error.message });
      else prunedRuns = pruned.data as number;

      processedOrganizations += 1;
    }

    results.push({
      organizationId, runId, chunks,
      groupsProcessed: processed, groupsFailed: failed,
      remaining, finished, observationsRefreshed, prunedRuns,
    });
  }

  const done = processedOrganizations >= pending.length && failures.length === 0;
  const response = {
    ok: failures.length === 0,
    done,
    organizationsPending: pending.length - processedOrganizations,
    organizations: results,
    failures,
    durationMs: Math.round(performance.now() - startedAt),
    checkedAt: new Date().toISOString(),
  };

  if (failures.length) {
    console.error("recovery_analysis_dispatch_partial_failure", response);
    return NextResponse.json(response, { status: 500 });
  }
  console.info("recovery_analysis_dispatch_succeeded", response);
  return NextResponse.json(response, { status: done ? 200 : 202 });
}

// O cron da Vercel manda GET; o da VPS manda POST. Mesma rota.
export async function GET(request: Request) {
  return POST(request);
}
