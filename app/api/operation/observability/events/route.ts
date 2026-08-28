import { NextResponse } from "next/server";

import { instagramObservedJson } from "@/lib/instagram/api-telemetry";
import {
  boundedInstagramLimit,
  decodeInstagramCursor,
  encodeInstagramCursor,
  instagramDomainsForScope,
  instagramPeriodDays,
  INSTAGRAM_FORMATS,
  INSTAGRAM_SEVERITIES,
  INSTAGRAM_TREATMENTS,
  isInstagramLogScope,
  isUuid,
  safeInstagramSearch,
  sanitizeInstagramEvidence,
} from "@/lib/instagram/observability";
import { getInstagramOperationContext } from "@/lib/instagram/request-context";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const startedAt = performance.now();
  let checkpoint = startedAt;
  const stages: Record<string, number> = {};
  const auth = await getInstagramOperationContext();
  if ("response" in auth) return auth.response;
  stages.context = performance.now() - checkpoint;
  checkpoint = performance.now();
  const url = new URL(request.url);
  const scope = url.searchParams.get("scope") ?? "activity";
  if (!isInstagramLogScope(scope))
    return NextResponse.json(
      { error: "Área de logs inválida." },
      { status: 400 },
    );
  const limit = boundedInstagramLimit(url.searchParams.get("limit"));
  const cursorValue = url.searchParams.get("cursor"),
    cursor = decodeInstagramCursor(cursorValue);
  if (cursorValue && !cursor)
    return NextResponse.json({ error: "Cursor inválido." }, { status: 400 });
  const profileId = url.searchParams.get("profileId"),
    groupId = url.searchParams.get("groupId");
  if ((profileId && !isUuid(profileId)) || (groupId && !isUuid(groupId)))
    return NextResponse.json({ error: "Filtro inválido." }, { status: 400 });
  const severity = url.searchParams.get("severity"),
    treatment = url.searchParams.get("treatment");
  const format = url.searchParams.get("format"),
    provider = safeInstagramSearch(url.searchParams.get("provider"), 40);
  const sourceStatus = safeInstagramSearch(url.searchParams.get("status"), 80);
  const workerKind = safeInstagramSearch(url.searchParams.get("worker"), 80);
  const connection = safeInstagramSearch(url.searchParams.get("connection"), 120);
  const batchId = url.searchParams.get("batchId");
  const jobId = url.searchParams.get("jobId");
  if (severity && !INSTAGRAM_SEVERITIES.includes(severity as never))
    return NextResponse.json(
      { error: "Severidade inválida." },
      { status: 400 },
    );
  if (treatment && !INSTAGRAM_TREATMENTS.includes(treatment as never))
    return NextResponse.json(
      { error: "Tratamento inválido." },
      { status: 400 },
    );
  if (format && !INSTAGRAM_FORMATS.includes(format as never))
    return NextResponse.json({ error: "Formato inválido." }, { status: 400 });
  if ((batchId && !isUuid(batchId)) || (jobId && !isUuid(jobId)))
    return NextResponse.json({ error: "Lote ou job inválido." }, { status: 400 });

  const admin = createSupabaseAdminClient(),
    organizationId = auth.context.activeOrganization.id;
  let currentGroupProfileIds: string[] | null = null;
  let filterConnectionIds: string[] | null = null;
  if (connection) {
    let connectionQuery = admin
      .from("zernio_connections_safe")
      .select("id")
      .eq("organization_id", organizationId)
      .limit(50);
    connectionQuery = isUuid(connection)
      ? connectionQuery.eq("id", connection)
      : connectionQuery.ilike("label", `%${connection}%`);
    const { data: matchingConnections } = await connectionQuery;
    filterConnectionIds = (matchingConnections ?? []).map((row) => row.id);
    if (!filterConnectionIds.length)
      return NextResponse.json({ events: [], clearedAt: null, hasMore: false, nextCursor: null });
  }
  if (groupId && url.searchParams.get("groupMode") === "current") {
    const { data: members } = await admin
      .from("profile_group_members")
      .select("profile_id")
      .eq("organization_id", organizationId)
      .eq("group_id", groupId);
    currentGroupProfileIds = (members ?? []).map((row) => row.profile_id);
    if (!currentGroupProfileIds.length)
      return NextResponse.json({
        events: [],
        clearedAt: null,
        hasMore: false,
        nextCursor: null,
      });
  }
  stages.filter_lookup = performance.now() - checkpoint;
  checkpoint = performance.now();
  const { data: preference } = await admin
    .from("instagram_observability_view_preferences")
    .select("cleared_at")
    .eq("organization_id", organizationId)
    .eq("actor_user_id", auth.context.user.id)
    .eq("scope_key", scope)
    .maybeSingle();
  stages.preference = performance.now() - checkpoint;
  checkpoint = performance.now();
  let query = admin
    .from("instagram_observability_events_enriched")
    .select(
      "id,occurred_at,incident_id,domain,severity,treatment_state,stage,event_type,stable_code,provider,source_status,publication_format,profile_id,connection_id,source_group_id,batch_id,item_id,job_id,attempt_id,worker_kind,worker_name,worker_id,http_status,provider_code,request_id,post_id,correlation_id,message,countermeasure,evidence,profile_username,profile_display_name,profile_provider,source_group_name,connection_label",
    )
    .eq("organization_id", organizationId)
    .gte(
      "occurred_at",
      new Date(
        Date.now() -
          instagramPeriodDays(url.searchParams.get("period")) * 86_400_000,
      ).toISOString(),
    )
    .order("occurred_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  if (scope !== "activity")
    query = query.in("domain", instagramDomainsForScope(scope));
  if (preference?.cleared_at)
    query = query.gt("occurred_at", preference.cleared_at);
  if (profileId) query = query.eq("profile_id", profileId);
  if (groupId && currentGroupProfileIds)
    query = query.in("profile_id", currentGroupProfileIds);
  else if (groupId) query = query.eq("source_group_id", groupId);
  if (severity) query = query.eq("severity", severity);
  if (treatment) query = query.eq("treatment_state", treatment);
  if (format) query = query.eq("publication_format", format);
  if (provider) query = query.eq("provider", provider);
  if (sourceStatus) query = query.eq("source_status", sourceStatus);
  if (workerKind) query = query.eq("worker_kind", workerKind);
  if (filterConnectionIds) query = query.in("connection_id", filterConnectionIds);
  if (batchId) query = query.eq("batch_id", batchId);
  if (jobId) query = query.eq("job_id", jobId);
  const search = safeInstagramSearch(url.searchParams.get("q"));
  if (search)
    query = query.or(
      `message.ilike.%${search}%,stable_code.ilike.%${search}%,request_id.ilike.%${search}%,post_id.ilike.%${search}%`,
    );
  if (cursor)
    query = query.or(
      `occurred_at.lt.${cursor.at},and(occurred_at.eq.${cursor.at},id.lt.${cursor.id})`,
    );
  const { data, error } = await query;
  if (error) {
    stages.query = performance.now() - checkpoint;
    console.error("instagram_observability_events_failed", {
      organizationId,
      code: error.code,
      error: error.message,
    });
    return instagramObservedJson(
      startedAt,
      organizationId,
      "events",
      { error: "Não foi possível carregar os eventos." },
      500,
      stages,
    );
  }
  stages.query = performance.now() - checkpoint;
  checkpoint = performance.now();
  const rows = data ?? [],
    page = rows.slice(0, limit);
  const canInspect = auth.context.activeOrganization.role !== "viewer";
  const events = page.map((row) => {
    const {
      profile_username: profileUsername,
      profile_display_name: profileDisplayName,
      profile_provider: profileProvider,
      source_group_name: sourceGroupName,
      connection_label: connectionLabel,
      ...event
    } = row;
    return {
      ...event,
      profile: row.profile_id && profileUsername ? {
        id: row.profile_id,
        username: profileUsername,
        display_name: profileDisplayName,
        provider: profileProvider,
      } : null,
      sourceGroupName,
      connectionLabel,
      workerName: auth.context.isSuperUser ? row.worker_name : null,
      workerId: auth.context.isSuperUser ? row.worker_id : null,
      evidence: canInspect ? sanitizeInstagramEvidence(row.evidence) : {},
    };
  });
  stages.enrichment = performance.now() - checkpoint;
  const last = page.at(-1);
  return instagramObservedJson(
    startedAt,
    organizationId,
    "events",
    {
      events,
      clearedAt: preference?.cleared_at ?? null,
      hasMore: rows.length > limit,
      nextCursor:
        rows.length > limit && last
          ? encodeInstagramCursor({ at: last.occurred_at, id: last.id })
          : null,
    },
    200,
    stages,
  );
}
