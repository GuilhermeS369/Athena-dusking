import { NextResponse } from "next/server";

import { INSTAGRAM_TREATMENTS, isUuid } from "@/lib/instagram/observability";
import { getInstagramOperationContext } from "@/lib/instagram/request-context";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ incidentId: string }> },
) {
  const auth = await getInstagramOperationContext("operator");
  if ("response" in auth) return auth.response;
  const { incidentId } = await params;
  if (!isUuid(incidentId))
    return NextResponse.json({ error: "Incidente inválido." }, { status: 400 });
  const body = (await request.json().catch(() => null)) as {
    treatment?: string;
    justification?: string;
    fixReference?: string;
  } | null;
  if (
    !body ||
    !["investigating", "resolved"].includes(body.treatment ?? "") ||
    !INSTAGRAM_TREATMENTS.includes(body.treatment as never)
  ) {
    return NextResponse.json(
      { error: "Tratamento inválido." },
      { status: 400 },
    );
  }
  if ((body.justification ?? "").trim().length < 8)
    return NextResponse.json(
      { error: "Informe uma justificativa com ao menos 8 caracteres." },
      { status: 400 },
    );
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc(
    "instagram_set_observability_incident_status",
    {
      p_incident_id: incidentId,
      p_treatment_state: body.treatment,
      p_justification: body.justification?.trim(),
      p_fix_reference: body.fixReference?.trim() || null,
    },
  );
  if (error)
    return NextResponse.json(
      { error: error.message || "Não foi possível atualizar o incidente." },
      { status: 400 },
    );
  return NextResponse.json({ incident: data });
}
