import { NextResponse } from "next/server";

import { isInstagramLogScope } from "@/lib/instagram/observability";
import { getInstagramOperationContext } from "@/lib/instagram/request-context";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const auth = await getInstagramOperationContext();
  if ("response" in auth) return auth.response;
  const body = (await request.json().catch(() => null)) as {
    scope?: string;
    action?: string;
  } | null;
  if (
    !isInstagramLogScope(body?.scope ?? null) ||
    !["clear", "undo"].includes(body?.action ?? "")
  ) {
    return NextResponse.json(
      { error: "Preferência inválida." },
      { status: 400 },
    );
  }
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc(
    "instagram_set_observability_view_preference",
    {
      p_organization_id: auth.context.activeOrganization.id,
      p_scope_key: body!.scope,
      p_action: body!.action,
    },
  );
  if (error)
    return NextResponse.json(
      { error: "Não foi possível atualizar a visualização." },
      { status: 500 },
    );
  return NextResponse.json({ preference: data });
}
