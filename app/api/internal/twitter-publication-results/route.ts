import { NextResponse } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { safelyRecordTwitterObservabilityEvent } from "@/lib/twitter/observability-server";
import { isTwitterWorkerAuthorized } from "@/lib/twitter/worker-auth";

const resolutions = new Set(["local_failure", "confirmed_failure", "rate_limited", "accepted", "published", "existing_post", "outcome_unknown"]);

export async function POST(request: Request) {
  if (!isTwitterWorkerAuthorized(request)) return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const admin = createSupabaseAdminClient();
  if (body.mode === "shadow") {
    if (typeof body.attemptId !== "string" || typeof body.idempotencyKey !== "string" || typeof body.fencingToken !== "string") return NextResponse.json({ error: "Resultado shadow inválido." }, { status: 400 });
    const { data: validFence } = await admin.rpc("twitter_validate_attempt_fence", { p_attempt_id: body.attemptId, p_fencing_token: body.fencingToken });
    if (validFence !== true) return NextResponse.json({ error: "Fencing da tentativa X inválido." }, { status: 409 });
    const { data, error } = await admin.rpc("twitter_complete_shadow_attempt", { p_attempt_id: body.attemptId, p_idempotency_key: body.idempotencyKey });
    return error ? NextResponse.json({ error: "Falha ao concluir shadow X." }, { status: 500 }) : NextResponse.json(data);
  }
  if (typeof body.attemptId !== "string" || typeof body.idempotencyKey !== "string" || typeof body.fencingToken !== "string" || typeof body.resolution !== "string" || !resolutions.has(body.resolution)) return NextResponse.json({ error: "Resultado X inválido." }, { status: 400 });
  const { data: validFence } = await admin.rpc("twitter_validate_attempt_fence", { p_attempt_id: body.attemptId, p_fencing_token: body.fencingToken });
  if (validFence !== true) return NextResponse.json({ error: "Fencing da tentativa X inválido." }, { status: 409 });
  const { data: attemptContext } = await admin.from("twitter_publication_attempts").select("organization_id,item_id,twitter_publication_items(profile_id,connection_id,program_id)").eq("id", body.attemptId).maybeSingle();
  if (!attemptContext) return NextResponse.json({ error: "Tentativa X não encontrada." }, { status: 404 });
  let resolution = body.resolution;
  let appliedRule: null | { id: string; action: string } = null;
  const phase = typeof body.phase === "string" ? body.phase.slice(0, 80) : "publication";
  const httpStatus = typeof body.httpStatus === "number" ? body.httpStatus : null;
  const providerCode = typeof body.providerCode === "string" ? body.providerCode : null;
  if (httpStatus !== null && providerCode) {
    const { data: rule } = await admin.from("twitter_financial_rules").select("id,action").eq("organization_id", attemptContext.organization_id).eq("phase", phase).eq("http_status", httpStatus).eq("provider_code", providerCode).eq("active", true).maybeSingle();
    if (rule) { appliedRule = rule; if (rule.action === "release") resolution = "confirmed_failure"; else if (rule.action === "retry") resolution = "rate_limited"; else if (rule.action === "hold") resolution = "outcome_unknown"; else if (rule.action === "settle") resolution = "published"; }
  }
  const evidence = { ...(body.evidence && typeof body.evidence === "object" ? body.evidence : {}), originalResolution: body.resolution, financialRuleId: appliedRule?.id ?? null };
  if (resolution === "rate_limited") {
    const { data: expiredRetry, error: expiredRetryError } = await admin.rpc("twitter_finalize_expired_rate_limit", {
      p_attempt_id: body.attemptId, p_idempotency_key: body.idempotencyKey,
      p_retry_after_seconds: typeof body.retryAfterSeconds === "number" ? body.retryAfterSeconds : 240,
      p_http_status: httpStatus, p_provider_code: providerCode,
      p_request_id: typeof body.requestId === "string" ? body.requestId : null,
      p_message: typeof body.message === "string" ? body.message.slice(0, 1000) : null, p_evidence: evidence,
    });
    if (expiredRetryError) return NextResponse.json({ error: "Falha ao encerrar retry X fora da janela." }, { status: 409 });
    if ((expiredRetry as { handled?: boolean } | null)?.handled === true) return NextResponse.json(expiredRetry);
  }
  const { data, error } = await admin.rpc("twitter_resolve_publication_attempt", { p_attempt_id: body.attemptId, p_resolution: resolution, p_idempotency_key: body.idempotencyKey, p_http_status: httpStatus, p_provider_code: providerCode, p_request_id: typeof body.requestId === "string" ? body.requestId : null, p_post_id: typeof body.postId === "string" ? body.postId : null, p_retry_after_seconds: typeof body.retryAfterSeconds === "number" ? body.retryAfterSeconds : null, p_message: typeof body.message === "string" ? body.message.slice(0, 1000) : null, p_evidence: evidence, p_manual: false, p_justification: null, p_actor_user_id: null, p_actor_email: null });
  if (error) return NextResponse.json({ error: "Falha ao registrar resultado X." }, { status: 409 });
  const item = Array.isArray(attemptContext.twitter_publication_items) ? attemptContext.twitter_publication_items[0] : attemptContext.twitter_publication_items as { profile_id?: string; connection_id?: string; program_id?: string } | null;
  if (item?.connection_id) await admin.rpc("twitter_record_connection_dispatch_signal", { p_connection_id: item.connection_id, p_signal: resolution === "rate_limited" ? "rate_limited" : ["published", "existing_post", "accepted"].includes(resolution) ? "success" : "failure", p_retry_after_seconds: typeof body.retryAfterSeconds === "number" ? body.retryAfterSeconds : null });
  const disconnectionSignal = providerCode === "account_disconnected" || providerCode === "auth_expired" ? providerCode : null;
  if (disconnectionSignal) await admin.rpc("twitter_schedule_profile_disconnection", { p_attempt_id: body.attemptId, p_signal: disconnectionSignal, p_provider_code: providerCode, p_provider_message: typeof body.message === "string" ? body.message : null });
  if (disconnectionSignal) await safelyRecordTwitterObservabilityEvent(admin, {
    organizationId: attemptContext.organization_id, domain: "account", severity: "warning", stage: "publication_signal", eventType: "account_unavailable_signal", stableCode: disconnectionSignal,
    message: "A publicação confirmou um dos dois sinais terminais homologados da conta X.", sourceType: "publication_account_signal", sourceId: `${body.attemptId}:${body.idempotencyKey}`,
    profileId: item?.profile_id, connectionId: item?.connection_id, programId: item?.program_id, itemId: attemptContext.item_id, attemptId: body.attemptId,
    workerName: "athena-twitter-publication-worker", httpStatus, providerCode, requestId: typeof body.requestId === "string" ? body.requestId : null,
    correlationId: body.idempotencyKey, evidence: { unconfirmed: false, publicationResolution: resolution },
  });
  return NextResponse.json({ ...(data as Record<string, unknown>), appliedFinancialRuleId: appliedRule?.id ?? null });
}
