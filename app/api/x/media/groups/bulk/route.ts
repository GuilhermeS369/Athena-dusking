import { NextResponse } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getTwitterRequestContext } from "@/lib/twitter/request-context";

export async function POST(request: Request) {
  const auth = await getTwitterRequestContext("operator");
  if ("response" in auth) return auth.response;
  const body = (await request.json().catch(() => ({}))) as {
    assetIds?: unknown;
    groupIds?: unknown;
    action?: unknown;
  };
  const assetIds = Array.isArray(body.assetIds)
    ? [
        ...new Set(
          body.assetIds.filter((id): id is string => typeof id === "string"),
        ),
      ]
    : [];
  const groupIds = Array.isArray(body.groupIds)
    ? [
        ...new Set(
          body.groupIds.filter((id): id is string => typeof id === "string"),
        ),
      ]
    : [];
  const action = body.action;
  if (
    !assetIds.length ||
    assetIds.length > 500 ||
    !groupIds.length ||
    groupIds.length > 100 ||
    !["add", "remove", "replace"].includes(String(action))
  )
    return NextResponse.json(
      { error: "Selecione mídias, grupos e uma operação válida." },
      { status: 400 },
    );
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.rpc(
    "twitter_update_media_group_assignments_bulk",
    {
      p_organization_id: auth.context.activeOrganization.id,
      p_media_asset_ids: assetIds,
      p_group_ids: groupIds,
      p_action: action,
      p_actor_user_id: auth.context.user.id,
    },
  );
  return error
    ? NextResponse.json(
        {
          error:
            error.code === "22023"
              ? error.message
              : "Não foi possível vincular as mídias ao grupo de perfis. Atualize o banco e tente novamente.",
        },
        { status: error.code === "22023" ? 400 : 500 },
      )
    : NextResponse.json({ assignments: data ?? [], affected: assetIds.length });
}
