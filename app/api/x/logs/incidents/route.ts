import { NextResponse } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { boundedTwitterLogLimit, decodeTwitterLogCursor, encodeTwitterLogCursor, safeTwitterLogSearch, TWITTER_INCIDENT_STATUSES, TWITTER_OBSERVABILITY_DOMAINS, TWITTER_OBSERVABILITY_SEVERITIES } from "@/lib/twitter/observability";
import { getTwitterRequestContext } from "@/lib/twitter/request-context";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await getTwitterRequestContext();
  if ("response" in auth) return auth.response;
  const url = new URL(request.url);
  const limit = boundedTwitterLogLimit(url.searchParams.get("limit"));
  const cursorValue = url.searchParams.get("cursor");
  const cursor = decodeTwitterLogCursor(cursorValue);
  if (cursorValue && !cursor) return NextResponse.json({ error: "Cursor de incidentes inválido." }, { status: 400 });
  const domain = url.searchParams.get("domain");
  const severity = url.searchParams.get("severity");
  const status = url.searchParams.get("status") ?? "active";
  if (domain && !TWITTER_OBSERVABILITY_DOMAINS.includes(domain as never)) return NextResponse.json({ error: "Domínio inválido." }, { status: 400 });
  if (severity && !TWITTER_OBSERVABILITY_SEVERITIES.includes(severity as never)) return NextResponse.json({ error: "Severidade inválida." }, { status: 400 });
  if (status !== "active" && status !== "all" && !TWITTER_INCIDENT_STATUSES.includes(status as never)) return NextResponse.json({ error: "Status inválido." }, { status: 400 });
  const search = safeTwitterLogSearch(url.searchParams.get("q"));
  const code = safeTwitterLogSearch(url.searchParams.get("code")), worker = safeTwitterLogSearch(url.searchParams.get("worker"));
  const period = url.searchParams.get("period") ?? "7d";
  const periodDays = period === "24h" ? 1 : period === "30d" ? 30 : period === "90d" ? 90 : 7;
  const profileId = url.searchParams.get("profileId"), connectionId = url.searchParams.get("connectionId"), programId = url.searchParams.get("programId");
  if ([profileId, connectionId, programId].some((value) => value && !/^[0-9a-f-]{36}$/i.test(value))) return NextResponse.json({ error: "Filtro por identificador inválido." }, { status: 400 });
  const admin = createSupabaseAdminClient();
  const entityIncidentSets: Set<string>[] = [];
  if (profileId) {
    const { data } = await admin.from("twitter_observability_incident_profiles").select("incident_id").eq("profile_id", profileId).limit(5_000);
    entityIncidentSets.push(new Set((data ?? []).map((row) => row.incident_id)));
  }
  for (const [entityType, entityId] of [["connection", connectionId], ["program", programId]] as const) if (entityId) {
    const { data } = await admin.from("twitter_observability_incident_entities").select("incident_id").eq("entity_type", entityType).eq("entity_id", entityId).limit(5_000);
    entityIncidentSets.push(new Set((data ?? []).map((row) => row.incident_id)));
  }
  const incidentIds = entityIncidentSets.length ? [...entityIncidentSets[0]].filter((id) => entityIncidentSets.every((set) => set.has(id))) : null;
  if (incidentIds?.length === 0) return NextResponse.json({ incidents: [], hasMore: false, nextCursor: null });
  let query = admin.from("twitter_observability_incidents")
    .select("id,fingerprint,domain,stage,stable_code,worker_name,severity,status,title,first_seen_at,last_seen_at,occurrence_count,affected_profile_count,reopen_count,resolved_at,resolution_justification,fix_reference")
    .eq("organization_id", auth.context.activeOrganization.id)
    .gte("last_seen_at", new Date(Date.now() - periodDays * 86_400_000).toISOString())
    .order("last_seen_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
  if (status === "active") query = query.in("status", ["open", "investigating"]);
  else if (status !== "all") query = query.eq("status", status);
  if (domain) query = query.eq("domain", domain);
  if (severity) query = query.eq("severity", severity);
  if (code) query = query.ilike("stable_code", `%${code}%`);
  if (worker) query = query.ilike("worker_name", `%${worker}%`);
  if (incidentIds) query = query.in("id", incidentIds);
  if (search) query = query.or(`title.ilike.%${search}%,stable_code.ilike.%${search}%,worker_name.ilike.%${search}%`);
  if (cursor) query = query.or(`last_seen_at.lt.${cursor.at},and(last_seen_at.eq.${cursor.at},id.lt.${cursor.id})`);
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: "Não foi possível carregar incidentes X." }, { status: 500 });
  const rows = data ?? [], page = rows.slice(0, limit), last = page.at(-1);
  return NextResponse.json({ incidents: page, hasMore: rows.length > limit, nextCursor: rows.length > limit && last ? encodeTwitterLogCursor({ at: last.last_seen_at, id: last.id }) : null });
}
