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
  const [summaryResult, queueResult, dispatchResult] = await Promise.all([
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
