import { NextResponse } from "next/server";

import { instagramObservedJson } from "@/lib/instagram/api-telemetry";
import {
  instagramIncidentActions,
  isUuid,
  sanitizeInstagramEvidence,
} from "@/lib/instagram/observability";
import { getInstagramOperationContext } from "@/lib/instagram/request-context";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ incidentId: string }> },
) {
  const startedAt = performance.now();
  const auth = await getInstagramOperationContext();
  if ("response" in auth) return auth.response;
  const { incidentId } = await params;
  if (!isUuid(incidentId))
    return NextResponse.json({ error: "Incidente inválido." }, { status: 400 });

  const admin = createSupabaseAdminClient();
  const organizationId = auth.context.activeOrganization.id;
  const { data: incident, error } = await admin
    .from("instagram_observability_incidents")
    .select("*")
    .eq("id", incidentId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error || !incident)
    return NextResponse.json({ error: "Incidente não encontrado." }, { status: 404 });

  const [eventsResult, profilesResult, entitiesResult, actionsResult] =
    await Promise.all([
      admin
        .from("instagram_observability_events")
        .select("id,occurred_at,severity,treatment_state,source_status,message,profile_id,connection_id,batch_id,item_id,job_id,attempt_id,worker_kind,http_status,provider_code,request_id,post_id,correlation_id,countermeasure,evidence")
        .eq("organization_id", organizationId)
        .eq("incident_id", incidentId)
        .order("occurred_at", { ascending: false })
        .limit(100),
      admin
        .from("instagram_observability_incident_profiles")
        .select("profile_id,first_seen_at,last_seen_at,occurrence_count")
        .eq("incident_id", incidentId)
        .order("last_seen_at", { ascending: false })
        .limit(100),
      admin
        .from("instagram_observability_incident_entities")
        .select("entity_type,entity_id,state,first_seen_at,last_seen_at,resolved_at,occurrence_count")
        .eq("incident_id", incidentId)
        .order("last_seen_at", { ascending: false })
        .limit(100),
      admin
        .from("instagram_observability_incident_actions")
        .select("id,previous_treatment,treatment_state,justification,fix_reference,actor_email,created_at")
        .eq("organization_id", organizationId)
        .eq("incident_id", incidentId)
        .order("created_at", { ascending: false })
        .limit(50),
    ]);

  const profileIds = (profilesResult.data ?? []).map((row) => row.profile_id);
  const { data: profileRows } = profileIds.length
    ? await admin
        .from("instagram_profiles_safe")
        .select("id,username,display_name,status,provider")
        .eq("organization_id", organizationId)
        .in("id", profileIds)
    : { data: [] };
  const profileMap = new Map((profileRows ?? []).map((row) => [row.id, row]));
  const canInspect = auth.context.activeOrganization.role !== "viewer";

  return instagramObservedJson(startedAt, organizationId, "incident-detail", {
    incident: {
      ...incident,
      availableActions: instagramIncidentActions(
        auth.context.activeOrganization.role,
        incident.treatment_state,
      ),
    },
    occurrences: (eventsResult.data ?? []).map((row) => ({
      ...row,
      evidence: canInspect ? sanitizeInstagramEvidence(row.evidence) : {},
    })),
    profiles: (profilesResult.data ?? []).map((row) => ({
      ...row,
      profile: profileMap.get(row.profile_id) ?? null,
    })),
    entities: entitiesResult.data ?? [],
    actions: (actionsResult.data ?? []).map((row) => ({
      ...row,
      actor_email: canInspect ? row.actor_email : null,
    })),
  });
}
