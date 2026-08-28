import { NextResponse } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getTwitterRequestContext } from "@/lib/twitter/request-context";

export async function GET(_request: Request, context: { params: Promise<{ archiveId: string }> }) {
  const auth = await getTwitterRequestContext("admin");
  if ("response" in auth) return auth.response;
  const { archiveId } = await context.params;
  const admin = createSupabaseAdminClient();
  const { data: archive } = await admin.from("twitter_observability_archives").select("storage_path").eq("id", archiveId).eq("organization_id", auth.context.activeOrganization.id).eq("status", "purged").maybeSingle();
  if (!archive) return NextResponse.json({ error: "Arquivo X não encontrado." }, { status: 404 });
  const { data, error } = await admin.storage.from("twitter-log-archives").createSignedUrl(archive.storage_path, 60, { download: true });
  return error || !data?.signedUrl ? NextResponse.json({ error: "Não foi possível assinar o download X." }, { status: 500 }) : NextResponse.redirect(data.signedUrl);
}
