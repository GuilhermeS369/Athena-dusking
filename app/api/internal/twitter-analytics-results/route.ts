import { NextResponse } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { safelyRecordTwitterObservabilityEvent } from "@/lib/twitter/observability-server";
import { twitterSeverityForResult } from "@/lib/twitter/observability";
import { isTwitterWorkerAuthorized } from "@/lib/twitter/worker-auth";

export async function POST(request: Request) {
  if (!isTwitterWorkerAuthorized(request, "analytics")) return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const resolution = String(body.resolution), billedUnits = body.billedUnits;
  if (typeof body.attemptId !== "string" || typeof body.idempotencyKey !== "string" || !["succeeded", "failed", "outcome_unknown"].includes(resolution) || resolution === "succeeded" && (!Number.isSafeInteger(billedUnits) || Number(billedUnits) < 0)) return NextResponse.json({ error: "Resultado de analytics inválido." }, { status: 400 });
  const admin = createSupabaseAdminClient();
  const { data: attempt } = await admin.from("twitter_analytics_attempts").select("organization_id,item_id,twitter_analytics_items(profile_id,connection_id,job_id)").eq("id", body.attemptId).maybeSingle();
  if (!attempt) return NextResponse.json({ error: "Tentativa de analytics não encontrada." }, { status: 404 });
  const { data, error } = await admin.rpc("twitter_complete_analytics_item", { p_attempt_id: body.attemptId, p_resolution: resolution, p_idempotency_key: body.idempotencyKey, p_metrics: body.metrics && typeof body.metrics === "object" ? body.metrics : {}, p_provider_updated_at: typeof body.providerUpdatedAt === "string" ? body.providerUpdatedAt : null, p_http_status: typeof body.httpStatus === "number" ? body.httpStatus : null, p_provider_code: typeof body.providerCode === "string" ? body.providerCode : null, p_request_id: typeof body.requestId === "string" ? body.requestId : null, p_message: typeof body.message === "string" ? body.message.slice(0, 1000) : null, p_evidence: body.evidence && typeof body.evidence === "object" ? body.evidence : {}, p_billed_units: resolution === "succeeded" ? Number(billedUnits) : null });
  if (error) return NextResponse.json({ error: "Falha ao registrar analytics X." }, { status: 409 });
  const item = Array.isArray(attempt.twitter_analytics_items) ? attempt.twitter_analytics_items[0] : attempt.twitter_analytics_items as { profile_id?: string; connection_id?: string; job_id?: string } | null;
  await safelyRecordTwitterObservabilityEvent(admin, { organizationId: attempt.organization_id, domain: "analytics", severity: twitterSeverityForResult(resolution, typeof body.httpStatus === "number" ? body.httpStatus : null), stage: "analytics_read", eventType: resolution, stableCode: typeof body.providerCode === "string" ? body.providerCode : resolution, message: typeof body.message === "string" ? body.message : `Resultado de analytics X: ${resolution}.`, sourceType: "analytics_result", sourceId: `${body.attemptId}:${body.idempotencyKey}`, profileId: item?.profile_id, connectionId: item?.connection_id, analyticsItemId: attempt.item_id, attemptId: body.attemptId, jobId: item?.job_id, workerName: "athena-twitter-analytics-worker", httpStatus: typeof body.httpStatus === "number" ? body.httpStatus : null, providerCode: typeof body.providerCode === "string" ? body.providerCode : null, requestId: typeof body.requestId === "string" ? body.requestId : null, correlationId: body.idempotencyKey, evidence: body.evidence });
  return NextResponse.json(data);
}
