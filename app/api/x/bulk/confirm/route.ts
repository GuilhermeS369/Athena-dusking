import { NextResponse } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { confirmTwitterBulkReview, type TwitterBulkRequest } from "@/lib/twitter/bulk-service";
import { isTwitterBulkScheduleV2Enabled } from "@/lib/twitter/feature";
import { safelyRecordTwitterObservabilityEvent } from "@/lib/twitter/observability-server";
import { getTwitterRequestContext } from "@/lib/twitter/request-context";

function schedulingCode(message: string) {
  const value = message.toLowerCase();
  if (/saldo|carteira|reserva|financ/.test(value)) return "schedule_funding_failed";
  if (/expir|revis/.test(value)) return "schedule_review_expired";
  if (/conflito|slot|hor.rio|agenda/.test(value)) return "schedule_slot_conflict";
  return "schedule_confirmation_failed";
}

export async function POST(request: Request) {
  const auth = await getTwitterRequestContext('operator');
  if ("response" in auth) return auth.response;
  if (!isTwitterBulkScheduleV2Enabled()) return NextResponse.json({ error: "A agenda X V2 está temporariamente desativada." }, { status: 503 });
  const body = await request.json().catch(() => null) as { request?: TwitterBulkRequest; reviewToken?: string; idempotencyKey?: string } | null;
  if (!body?.request || !body.reviewToken || !body.idempotencyKey) return NextResponse.json({ error: "Confirmação inválida." }, { status: 400 });
  const admin = createSupabaseAdminClient(), organizationId = auth.context.activeOrganization.id;
  try {
    const result = await confirmTwitterBulkReview({ organizationId, actorUserId: auth.context.user.id, request: body.request, reviewToken: body.reviewToken, idempotencyKey: body.idempotencyKey });
    const record = result as Record<string, unknown>;
    await safelyRecordTwitterObservabilityEvent(admin, { organizationId, domain: "scheduling", severity: "info", stage: "bulk_confirmation", eventType: "schedule_confirmed", stableCode: "schedule_confirmed", message: "Programação em massa X confirmada.", sourceType: "bulk_confirmation", sourceId: `${body.idempotencyKey}:succeeded`, programId: typeof record.programId === "string" ? record.programId : null, correlationId: body.idempotencyKey, evidence: { fundedCount: record.fundedCount, unfundedCount: record.unfundedCount, totalRequested: record.totalRequested } });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha na confirmação X.";
    const status = (error as { status?: number }).status ?? 400;
    await safelyRecordTwitterObservabilityEvent(admin, { organizationId, domain: "scheduling", severity: status >= 500 ? "error" : "warning", stage: "bulk_confirmation", eventType: "schedule_failed", stableCode: schedulingCode(message), message, sourceType: "bulk_confirmation", sourceId: `${body.idempotencyKey}:failed`, correlationId: body.idempotencyKey, evidence: { httpStatus: status } });
    return NextResponse.json({ error: message }, { status });
  }
}
