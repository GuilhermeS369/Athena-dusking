import { NextResponse } from "next/server";

import { instagramObservedJson } from "@/lib/instagram/api-telemetry";
import { getInstagramOperationContext } from "@/lib/instagram/request-context";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const startedAt = performance.now();
  const stages: Record<string, number> = {};
  const auth = await getInstagramOperationContext();
  if ("response" in auth) return auth.response;
  stages.context = performance.now() - startedAt;
  const queryStartedAt = performance.now();
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  const organizationId = auth.context.activeOrganization.id;
  const [summaryResult, queueResult, dispatchResult, pendingArchiveResult] = await Promise.all([
    supabase.rpc("get_instagram_observability_summary", {
      p_organization_id: organizationId,
    }),
    admin.rpc("get_publication_queue_operational_snapshot", {
      p_organization_id: organizationId,
    }),
    admin.rpc("get_publication_dispatch_state_snapshot", {
      p_organization_id: organizationId,
      p_stalled_after_seconds: 600,
    }),
    // Quantos itens encerrados ainda esperam arquivamento. O worker de
    // manutenção drena isso a cada 10 min; o número existe no painel para que
    // nunca mais volte a crescer despercebido — foi assim que chegou a 212 mil.
    //
    // 'failed' NÃO entra mais nesta conta. Desde a migration 335,
    // `clean_publication_queue_finished` só arquiva falha terminal
    // (`next_attempt_at is null or attempt_count >= 5`, mais janela de
    // acomodação), porque arquivar uma falha com retry marcado impedia o item
    // de ser reivindicado outra vez e a publicação sumia sem sinal. Contar as
    // falhas retentáveis aqui mostraria um saldo permanente que o worker nunca
    // vai drenar — um alarme que não corresponde a trabalho pendente.
    //
    // O predicado restante é coberto por
    // `publication_items_finished_cleanup_idx`, então é uma contagem barata.
    admin
      .from("publication_items")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .in("status", ["published", "cancelled", "removed", "ignored"]),
  ]);
  stages.queries = performance.now() - queryStartedAt;
  if (summaryResult.error) {
    console.error("instagram_observability_summary_failed", {
      organizationId,
      error: summaryResult.error.message,
    });
    return instagramObservedJson(
      startedAt,
      organizationId,
      "summary",
      { error: "Não foi possível carregar o resumo operacional." },
      500,
      stages,
    );
  }
  const queueSnapshot = (queueResult.data ?? {}) as {
    rows?: Array<Record<string, unknown>>;
    generatedAt?: string | null;
    stale?: boolean;
  };
  const queue = (queueSnapshot.rows ?? []).reduce(
    (
      total: {
        active: number;
        overdue: number;
        retries: number;
        expiredLeases: number;
      },
      row: Record<string, unknown>,
    ) => ({
      active: total.active + Number(row.total ?? 0),
      overdue: total.overdue + Number(row.overdue ?? 0),
      retries: total.retries + Number(row.due_retries ?? 0),
      expiredLeases: total.expiredLeases + Number(row.expired_leases ?? 0),
    }),
    { active: 0, overdue: 0, retries: 0, expiredLeases: 0 },
  );
  if (pendingArchiveResult.error) {
    console.error("publication_pending_archive_count_failed", {
      organizationId,
      error: pendingArchiveResult.error.message,
    });
  }
  if (dispatchResult.error) {
    console.error("publication_dispatch_state_snapshot_failed", {
      organizationId,
      error: dispatchResult.error.message,
    });
  }

  return instagramObservedJson(
    startedAt,
    organizationId,
    "summary",
    {
      ...summaryResult.data,
      queue: {
        ...queue,
        // `null` quando a contagem falhou, para a tela distinguir "zero
        // esperando" de "não consegui medir".
        pendingArchive: pendingArchiveResult.error ? null : pendingArchiveResult.count ?? 0,
        generatedAt: queueSnapshot.generatedAt ?? null,
        stale: queueSnapshot.stale ?? true,
      },
      dispatch: dispatchResult.error ? null : dispatchResult.data,
      role: auth.context.activeOrganization.role,
      isSuperUser: auth.context.isSuperUser,
    },
    200,
    stages,
  );
}
