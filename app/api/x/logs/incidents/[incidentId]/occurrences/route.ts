import { NextResponse } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { boundedTwitterLogLimit, decodeTwitterLogCursor, encodeTwitterLogCursor, sanitizeTwitterEvidence } from "@/lib/twitter/observability";
import { getTwitterRequestContext } from "@/lib/twitter/request-context";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ incidentId: string }> }) {
  const auth = await getTwitterRequestContext();
  if ("response" in auth) return auth.response;
  const { incidentId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(incidentId)) return NextResponse.json({ error: "Incidente inválido." }, { status: 400 });
  const url = new URL(request.url), limit = boundedTwitterLogLimit(url.searchParams.get("limit"));
  const cursorValue = url.searchParams.get("cursor"), cursor = decodeTwitterLogCursor(cursorValue);
  if (cursorValue && !cursor) return NextResponse.json({ error: "Cursor inválido." }, { status: 400 });
  const admin = createSupabaseAdminClient();
  const { data: incident } = await admin.from("twitter_observability_incidents").select("id").eq("id", incidentId).eq("organization_id", auth.context.activeOrganization.id).maybeSingle();
  if (!incident) return NextResponse.json({ error: "Incidente X não encontrado." }, { status: 404 });
  let query = admin.from("twitter_observability_events")
    .select("id,occurred_at,domain,severity,stage,event_type,stable_code,profile_id,connection_id,program_id,item_id,analytics_item_id,attempt_id,job_id,worker_name,worker_id,http_status,provider_code,request_id,post_id,correlation_id,message,evidence")
    .eq("organization_id", auth.context.activeOrganization.id).eq("incident_id", incidentId)
    .order("occurred_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
  if (cursor) query = query.or(`occurred_at.lt.${cursor.at},and(occurred_at.eq.${cursor.at},id.lt.${cursor.id})`);
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: "Não foi possível carregar ocorrências X." }, { status: 500 });
  const rows = data ?? [], page = rows.slice(0, limit);
  const profileIds = [...new Set(page.map((row) => row.profile_id).filter(Boolean))] as string[];
  const connectionIds = [...new Set(page.map((row) => row.connection_id).filter(Boolean))] as string[];
  const [{ data: profiles }, { data: connections }] = await Promise.all([
    profileIds.length ? admin.from("twitter_profiles").select("id,username").in("id", profileIds) : Promise.resolve({ data: [] }),
    connectionIds.length ? admin.from("twitter_connections").select("id,label").in("id", connectionIds) : Promise.resolve({ data: [] }),
  ]);
  const profileMap = new Map((profiles ?? []).map((row) => [row.id, row.username]));
  const connectionMap = new Map((connections ?? []).map((row) => [row.id, row.label]));
  const canInspect = auth.context.activeOrganization.role !== "viewer";
  const occurrences = page.map((row) => ({ ...row, username: row.profile_id ? profileMap.get(row.profile_id) ?? null : null, connectionLabel: row.connection_id ? connectionMap.get(row.connection_id) ?? null : null, evidence: canInspect ? sanitizeTwitterEvidence(row.evidence) : {} }));
  const last = page.at(-1);
  return NextResponse.json({ occurrences, hasMore: rows.length > limit, nextCursor: rows.length > limit && last ? encodeTwitterLogCursor({ at: last.occurred_at, id: last.id }) : null });
}

