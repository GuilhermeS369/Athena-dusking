import { NextResponse } from "next/server";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isTwitterLogScope } from "@/lib/twitter/observability";
import { getTwitterRequestContext } from "@/lib/twitter/request-context";

export async function POST(request: Request) {
  const auth = await getTwitterRequestContext();
  if ("response" in auth) return auth.response;
  const body = await request.json().catch(() => ({})) as { scope?: unknown; action?: unknown };
  if (typeof body.scope !== "string" || !isTwitterLogScope(body.scope) || (body.action !== "clear" && body.action !== "undo")) return NextResponse.json({ error: "Preferência inválida." }, { status: 400 });
  const { data, error } = await (await createSupabaseServerClient()).rpc("twitter_set_observability_view_preference", { p_organization_id: auth.context.activeOrganization.id, p_scope_key: body.scope, p_action: body.action });
  if (error) return NextResponse.json({ error: "Não foi possível alterar a visualização." }, { status: 500 });
  return NextResponse.json({ preference: data });
}
