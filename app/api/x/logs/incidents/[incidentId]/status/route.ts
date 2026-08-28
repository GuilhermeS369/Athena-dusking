import { NextResponse } from "next/server";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { TWITTER_INCIDENT_STATUSES } from "@/lib/twitter/observability";
import { getTwitterRequestContext } from "@/lib/twitter/request-context";

export async function POST(request: Request, context: { params: Promise<{ incidentId: string }> }) {
  const auth = await getTwitterRequestContext("operator");
  if ("response" in auth) return auth.response;
  const { incidentId } = await context.params;
  const body = await request.json().catch(() => ({})) as { status?: unknown; justification?: unknown; fixReference?: unknown };
  if (!/^[0-9a-f-]{36}$/i.test(incidentId) || typeof body.status !== "string" || !TWITTER_INCIDENT_STATUSES.includes(body.status as never) || typeof body.justification !== "string" || body.justification.trim().length < 8 || (body.fixReference != null && typeof body.fixReference !== "string")) return NextResponse.json({ error: "Status e justificativa são obrigatórios." }, { status: 400 });
  const { data, error } = await (await createSupabaseServerClient()).rpc("twitter_set_observability_incident_status", { p_incident_id: incidentId, p_status: body.status, p_justification: body.justification.trim(), p_fix_reference: typeof body.fixReference === "string" ? body.fixReference.trim() || null : null });
  if (error) return NextResponse.json({ error: error.code === "P0002" ? "Incidente não encontrado." : "Não foi possível atualizar o incidente." }, { status: error.code === "P0002" ? 404 : 409 });
  return NextResponse.json({ incident: data });
}

