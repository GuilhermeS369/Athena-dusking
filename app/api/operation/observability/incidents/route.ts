import { NextResponse } from "next/server";

import { instagramObservedJson } from "@/lib/instagram/api-telemetry";
import {
  boundedInstagramLimit,
  instagramDomainsForScope,
  instagramIncidentActions,
  INSTAGRAM_SEVERITIES,
  INSTAGRAM_TREATMENTS,
  isInstagramLogScope,
  isUuid,
  safeInstagramSearch,
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
  const url = new URL(request.url),
    admin = createSupabaseAdminClient();
  const organizationId = auth.context.activeOrganization.id;
  const profileId = url.searchParams.get("profileId");
  const groupId = url.searchParams.get("groupId");
  const groupMode =
    url.searchParams.get("groupMode") === "current" ? "current" : "origin";
  if ((profileId && !isUuid(profileId)) || (groupId && !isUuid(groupId)))
    return NextResponse.json({ error: "Perfil inválido." }, { status: 400 });
  const severity = url.searchParams.get("severity"),
    treatment = url.searchParams.get("treatment");
  const scope = url.searchParams.get("scope") ?? "activity";
  if (!isInstagramLogScope(scope))
    return NextResponse.json({ error: "Área de logs inválida." }, { status: 400 });
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
  let incidentIds: string[] | null = null;
  if (profileId) {
    const { data } = await admin
      .from("instagram_observability_incident_profiles")
      .select("incident_id")
      .eq("profile_id", profileId);
    incidentIds = (data ?? []).map((row) => row.incident_id);
    if (!incidentIds.length) return NextResponse.json({ incidents: [] });
  }
  if (groupId) {
    const { data, error } = await admin.rpc(
      "get_instagram_group_observability_incident_ids",
      {
        p_organization_id: organizationId,
        p_group_id: groupId,
        p_group_mode: groupMode,
      },
    );
    if (error)
      return NextResponse.json(
        { error: "Não foi possível filtrar os incidentes do grupo." },
        { status: 500 },
      );
    const groupIncidentIds = (data ?? []).map(
      (row: { incident_id: string }) => row.incident_id,
    );
    if (!groupIncidentIds.length) return NextResponse.json({ incidents: [] });
    incidentIds = groupIncidentIds;
  }
  stages.filter_lookup = performance.now() - checkpoint;
  checkpoint = performance.now();
  let query = admin
    .from("instagram_observability_incidents")
    .select(
      "id,domain,stage,stable_code,provider,worker_kind,severity,treatment_state,title,first_seen_at,last_seen_at,occurrence_count,affected_profile_count,reopen_count,latest_countermeasure,investigating_at,resolved_at,resolution_justification,fix_reference",
    )
    .eq("organization_id", organizationId)
    .order("last_seen_at", { ascending: false })
    .limit(boundedInstagramLimit(url.searchParams.get("limit"), 30, 50));
  if (scope !== "activity")
    query = query.in("domain", instagramDomainsForScope(scope));
  if (incidentIds) query = query.in("id", incidentIds);
  if (severity) query = query.eq("severity", severity);
  if (treatment) query = query.eq("treatment_state", treatment);
  else query = query.neq("treatment_state", "resolved");
  const search = safeInstagramSearch(url.searchParams.get("q"));
  if (search)
    query = query.or(`title.ilike.%${search}%,stable_code.ilike.%${search}%`);
  const { data, error } = await query;
  if (error)
    return NextResponse.json(
      { error: "Não foi possível carregar os incidentes." },
      { status: 500 },
    );
  stages.query = performance.now() - checkpoint;
  return instagramObservedJson(
    startedAt,
    organizationId,
    "incidents",
    {
      incidents: (data ?? []).map((incident) => ({
        ...incident,
        availableActions: instagramIncidentActions(
          auth.context.activeOrganization.role,
          incident.treatment_state,
        ),
      })),
    },
    200,
    stages,
  );
}
