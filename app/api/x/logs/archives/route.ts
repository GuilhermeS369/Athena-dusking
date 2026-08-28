import { NextResponse } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getTwitterRequestContext } from "@/lib/twitter/request-context";

export async function GET() {
  const auth = await getTwitterRequestContext("admin");
  if ("response" in auth) return auth.response;
  const { data, error } = await createSupabaseAdminClient().from("twitter_observability_archives").select("id,period_start,period_end,row_count,byte_count,sha256,status,created_at").eq("organization_id", auth.context.activeOrganization.id).order("period_start", { ascending: false }).limit(100);
  return error ? NextResponse.json({ error: "Não foi possível carregar arquivos históricos X." }, { status: 500 }) : NextResponse.json({ archives: data ?? [] });
}

