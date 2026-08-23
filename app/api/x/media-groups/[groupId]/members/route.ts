import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getTwitterRequestContext } from "@/lib/twitter/request-context";
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ groupId: string }> },
) {
  const auth = await getTwitterRequestContext("operator");
  if ("response" in auth) return auth.response;
  const { groupId } = await params;
  if (!uuid.test(groupId))
    return NextResponse.json({ error: "Grupo inválido." }, { status: 400 });
  const body = (await request.json().catch(() => ({}))) as {
    assetIds?: unknown;
  };
  const assetIds = Array.isArray(body.assetIds)
    ? [
        ...new Set(
          body.assetIds.filter(
            (id): id is string => typeof id === "string" && uuid.test(id),
          ),
        ),
      ]
    : [];
  if (!assetIds.length || assetIds.length > 500)
    return NextResponse.json(
      { error: "Selecione de 1 a 500 mídias." },
      { status: 400 },
    );
  const admin = createSupabaseAdminClient();
  const [
    { data: group, error: groupError },
    { data: assets, error: assetError },
  ] = await Promise.all([
    admin
      .from("twitter_groups")
      .select("id")
      .eq("id", groupId)
      .eq("organization_id", auth.context.activeOrganization.id)
      .is("deleted_at", null)
      .maybeSingle(),
    admin
      .from("twitter_media_assets")
      .select("id")
      .eq("organization_id", auth.context.activeOrganization.id)
      .in("id", assetIds)
      .is("deleted_at", null),
  ]);
  if (
    groupError ||
    assetError ||
    !group ||
    (assets ?? []).length !== assetIds.length
  )
    return NextResponse.json(
      { error: "Grupo ou mídia não pertence à organização." },
      { status: 400 },
    );
  const { error } = await admin.from("twitter_media_group_members").upsert(
    assetIds.map((assetId) => ({
      organization_id: auth.context.activeOrganization.id,
      group_id: groupId,
      asset_id: assetId,
      added_by: auth.context.user.id,
    })),
    { onConflict: "group_id,asset_id" },
  );
  return error
    ? NextResponse.json(
        { error: "Não foi possível agrupar as mídias X." },
        { status: 500 },
      )
    : NextResponse.json({ assigned: assetIds.length });
}
