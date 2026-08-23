import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getTwitterRequestContext } from "@/lib/twitter/request-context";

export async function GET() {
  const auth = await getTwitterRequestContext();
  if ("response" in auth) return auth.response;
  const { data, error } = await createSupabaseAdminClient()
    .from("twitter_groups")
    .select("id,name")
    .eq("organization_id", auth.context.activeOrganization.id)
    .is("deleted_at", null)
    .order("name");
  return error
    ? NextResponse.json(
      { error: "Não foi possível carregar os grupos de perfis X." },
        { status: 500 },
      )
    : NextResponse.json({ groups: data ?? [] });
}
export async function POST(request: Request) {
  const auth = await getTwitterRequestContext("operator");
  if ("response" in auth) return auth.response;
  void request;
  return NextResponse.json(
    {
      error:
        "Crie e gerencie grupos na página Grupos. A galeria usa os mesmos grupos dos perfis.",
    },
    { status: 405 },
  );
}
