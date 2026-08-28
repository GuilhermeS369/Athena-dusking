import { NextResponse } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { boundedTwitterLogLimit, decodeTwitterLogCursor, encodeTwitterLogCursor, isTwitterLogScope, safeTwitterLogSearch, sanitizeTwitterEvidence, twitterLogDomainsForScope, TWITTER_OBSERVABILITY_SEVERITIES } from "@/lib/twitter/observability";
import { getTwitterRequestContext } from "@/lib/twitter/request-context";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await getTwitterRequestContext();
  if ("response" in auth) return auth.response;
  const url = new URL(request.url), scope = url.searchParams.get("scope") ?? "activity";
  if (!isTwitterLogScope(scope)) return NextResponse.json({ error: "Lista de logs inválida." }, { status: 400 });
  const limit = boundedTwitterLogLimit(url.searchParams.get("limit"));
  const cursorValue = url.searchParams.get("cursor"), cursor = decodeTwitterLogCursor(cursorValue);
  if (cursorValue && !cursor) return NextResponse.json({ error: "Cursor inválido." }, { status: 400 });
  const severity = url.searchParams.get("severity"), profileId = url.searchParams.get("profileId"), connectionId = url.searchParams.get("connectionId"), programId = url.searchParams.get("programId"), worker = safeTwitterLogSearch(url.searchParams.get("worker")), code = safeTwitterLogSearch(url.searchParams.get("code")), search = safeTwitterLogSearch(url.searchParams.get("q"));
  const period = url.searchParams.get("period") ?? "7d", periodDays = period === "24h" ? 1 : period === "30d" ? 30 : period === "90d" ? 90 : 7;
  if ([profileId, connectionId, programId].some((value) => value && !/^[0-9a-f-]{36}$/i.test(value))) return NextResponse.json({ error: "Filtro por identificador inválido." }, { status: 400 });
  if (severity && !TWITTER_OBSERVABILITY_SEVERITIES.includes(severity as never)) return NextResponse.json({ error: "Severidade inválida." }, { status: 400 });
  const admin = createSupabaseAdminClient(), organizationId = auth.context.activeOrganization.id;
  const { data: preference } = await admin.from("twitter_observability_view_preferences").select("cleared_at").eq("organization_id", organizationId).eq("actor_user_id", auth.context.user.id).eq("scope_key", scope).maybeSingle();
  let query = admin.from("twitter_observability_events")
    .select("id,occurred_at,incident_id,domain,severity,stage,event_type,stable_code,profile_id,connection_id,program_id,item_id,analytics_item_id,attempt_id,job_id,worker_name,worker_id,http_status,provider_code,request_id,post_id,correlation_id,message,evidence")
    .eq("organization_id", organizationId).in("domain", twitterLogDomainsForScope(scope))
    .gte("occurred_at", new Date(Date.now() - periodDays * 86_400_000).toISOString())
    .order("occurred_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
  if (preference?.cleared_at) query = query.gt("occurred_at", preference.cleared_at);
  if (severity) query = query.eq("severity", severity);
  if (profileId) query = query.eq("profile_id", profileId);
  if (connectionId) query = query.eq("connection_id", connectionId);
  if (programId) query = query.eq("program_id", programId);
  if (worker) query = query.ilike("worker_name", `%${worker}%`);
  if (code) query = query.ilike("stable_code", `%${code}%`);
  if (search) query = query.or(`message.ilike.%${search}%,stable_code.ilike.%${search}%,request_id.ilike.%${search}%,post_id.ilike.%${search}%,source_id.ilike.%${search}%`);
  if (cursor) query = query.or(`occurred_at.lt.${cursor.at},and(occurred_at.eq.${cursor.at},id.lt.${cursor.id})`);
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: "Não foi possível carregar eventos X." }, { status: 500 });
  const rows = data ?? [], page = rows.slice(0, limit);
  const profileIds = [...new Set(page.map((row) => row.profile_id).filter(Boolean))] as string[];
  const connectionIds = [...new Set(page.map((row) => row.connection_id).filter(Boolean))] as string[];
  const [{ data: profiles }, { data: connections }] = await Promise.all([
    profileIds.length ? admin.from("twitter_profiles").select("id,username").in("id", profileIds) : Promise.resolve({ data: [] }),
    connectionIds.length ? admin.from("twitter_connections").select("id,label").in("id", connectionIds) : Promise.resolve({ data: [] }),
  ]);
  const profileMap = new Map((profiles ?? []).map((row) => [row.id, row.username])), connectionMap = new Map((connections ?? []).map((row) => [row.id, row.label]));
  const canInspect = auth.context.activeOrganization.role !== "viewer";
  const events = page.map((row) => ({ ...row, username: row.profile_id ? profileMap.get(row.profile_id) ?? null : null, connectionLabel: row.connection_id ? connectionMap.get(row.connection_id) ?? null : null, evidence: canInspect ? sanitizeTwitterEvidence(row.evidence) : {} }));
  const last = page.at(-1);
  return NextResponse.json({ events, clearedAt: preference?.cleared_at ?? null, hasMore: rows.length > limit, nextCursor: rows.length > limit && last ? encodeTwitterLogCursor({ at: last.occurred_at, id: last.id }) : null });
}
