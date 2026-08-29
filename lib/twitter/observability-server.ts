import type { SupabaseClient } from "@supabase/supabase-js";

import { fetchAllRows } from "@/lib/supabase/paginate";

import { normalizeTwitterErrorMessage, sanitizeTwitterEvidence, type TwitterObservabilityDomain, type TwitterObservabilitySeverity } from "./observability";

type TwitterObservabilityInput = {
  organizationId: string;
  domain: TwitterObservabilityDomain;
  severity: TwitterObservabilitySeverity;
  stage: string;
  eventType: string;
  stableCode: string;
  message: string;
  sourceType: string;
  sourceId: string;
  occurredAt?: string | null;
  profileId?: string | null;
  connectionId?: string | null;
  programId?: string | null;
  itemId?: string | null;
  analyticsItemId?: string | null;
  attemptId?: string | null;
  jobId?: string | null;
  workerName?: string | null;
  workerId?: string | null;
  httpStatus?: number | null;
  providerCode?: string | null;
  requestId?: string | null;
  postId?: string | null;
  correlationId?: string | null;
  evidence?: unknown;
};

export async function recordTwitterObservabilityEvent(admin: SupabaseClient, input: TwitterObservabilityInput) {
  const { data, error } = await admin.rpc("twitter_record_observability_event", {
    p_organization_id: input.organizationId,
    p_domain: input.domain,
    p_severity: input.severity,
    p_stage: input.stage,
    p_event_type: input.eventType,
    p_stable_code: input.stableCode,
    p_message: normalizeTwitterErrorMessage(input.message),
    p_source_type: input.sourceType,
    p_source_id: input.sourceId,
    p_occurred_at: input.occurredAt ?? new Date().toISOString(),
    p_profile_id: input.profileId ?? null,
    p_connection_id: input.connectionId ?? null,
    p_program_id: input.programId ?? null,
    p_item_id: input.itemId ?? null,
    p_analytics_item_id: input.analyticsItemId ?? null,
    p_attempt_id: input.attemptId ?? null,
    p_job_id: input.jobId ?? null,
    p_worker_name: input.workerName ?? null,
    p_worker_id: input.workerId ?? null,
    p_http_status: input.httpStatus ?? null,
    p_provider_code: input.providerCode ?? null,
    p_request_id: input.requestId ?? null,
    p_post_id: input.postId ?? null,
    p_correlation_id: input.correlationId ?? null,
    p_evidence: sanitizeTwitterEvidence(input.evidence),
  });
  if (error) throw new Error(`Falha ao registrar observabilidade X: ${error.message}`);
  return data as { eventId: string; incidentId: string | null; occurredAt: string };
}

export async function safelyRecordTwitterObservabilityEvent(admin: SupabaseClient, input: TwitterObservabilityInput) {
  try { return await recordTwitterObservabilityEvent(admin, input); }
  catch (error) { console.error("[twitter-observability-write]", { domain: input.domain, stage: input.stage, code: input.stableCode, sourceType: input.sourceType, sourceId: input.sourceId, message: error instanceof Error ? error.message : "Falha desconhecida" }); return null; }
}

export async function recordTwitterSystemEventForOrganizations(
  admin: SupabaseClient,
  input: Omit<TwitterObservabilityInput, "organizationId">,
) {
  // O .limit(10_000) era neutralizado por max_rows: só as 1.000 primeiras
  // conexões eram lidas, e como a distinção de organização acontece aqui em
  // memória, organizações inteiras nunca recebiam eventos de sistema.
  const { data, error } = await fetchAllRows<{ id: string; organization_id: string }>((from, to) => admin.from("twitter_connections").select("id,organization_id").neq("status", "deleted").is("deleted_at", null).order("id").range(from, to));
  if (error) throw new Error(`Falha ao localizar organizações X: ${error.message}`);
  const organizationIds = [...new Set(data.map((row) => row.organization_id))];
  await Promise.all(organizationIds.map((organizationId) => safelyRecordTwitterObservabilityEvent(admin, { ...input, organizationId })));
  return organizationIds.length;
}
