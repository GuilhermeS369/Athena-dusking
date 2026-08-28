import { NextResponse } from "next/server";

import {
  boundedInstagramLimit,
  safeInstagramSearch,
} from "@/lib/instagram/observability";
import { getInstagramOperationContext } from "@/lib/instagram/request-context";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await getInstagramOperationContext();
  if ("response" in auth) return auth.response;
  const url = new URL(request.url),
    type = url.searchParams.get("type") ?? "profile";
  const q = safeInstagramSearch(url.searchParams.get("q")),
    limit = boundedInstagramLimit(url.searchParams.get("limit"), 20, 30);
  const admin = createSupabaseAdminClient(),
    organizationId = auth.context.activeOrganization.id;
  if (type === "profile") {
    let query = admin
      .from("instagram_profiles_safe")
      .select("id,username,display_name,provider,status")
      .eq("organization_id", organizationId)
      .is("deleted_at", null)
      .order("username")
      .limit(limit);
    if (q)
      query = query.or(
        `username.ilike.%${q.replace(/^@/, "")}%,display_name.ilike.%${q}%`,
      );
    const { data, error } = await query;
    if (error)
      return NextResponse.json(
        { error: "Não foi possível buscar perfis." },
        { status: 500 },
      );
    return NextResponse.json({ options: data ?? [] });
  }
  if (type === "group") {
    let query = admin
      .from("profile_groups")
      .select("id,name")
      .eq("organization_id", organizationId)
      .is("deleted_at", null)
      .order("name")
      .limit(limit);
    if (q) query = query.ilike("name", `%${q}%`);
    const { data, error } = await query;
    if (error)
      return NextResponse.json(
        { error: "Não foi possível buscar grupos." },
        { status: 500 },
      );
    const ids = (data ?? []).map((row) => row.id);
    const { data: members } = ids.length
      ? await admin
          .from("profile_group_members")
          .select("group_id")
          .in("group_id", ids)
      : { data: [] };
    const counts = new Map<string, number>();
    for (const member of members ?? [])
      counts.set(member.group_id, (counts.get(member.group_id) ?? 0) + 1);
    return NextResponse.json({
      options: (data ?? []).map((row) => ({
        ...row,
        profileCount: counts.get(row.id) ?? 0,
      })),
    });
  }
  return NextResponse.json(
    { error: "Tipo de busca inválido." },
    { status: 400 },
  );
}
