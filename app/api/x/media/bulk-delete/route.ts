import { NextResponse } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getTwitterRequestContext } from "@/lib/twitter/request-context";
import type { TwitterGalleryRow } from "@/lib/twitter/gallery";

function filtersFrom(body: Record<string, unknown>) {
  const filters =
    body.filters && typeof body.filters === "object"
      ? (body.filters as Record<string, unknown>)
      : {};
  const group = typeof filters.group === "string" ? filters.group : "all";
  return {
    search:
      typeof filters.search === "string" ? filters.search.slice(0, 100) : "",
    type: ["image", "gif", "video"].includes(String(filters.type))
      ? String(filters.type)
      : "all",
    status: typeof filters.status === "string" ? filters.status : "all",
    groupId: group !== "all" && group !== "none" ? group : null,
    ungrouped: group === "none",
  };
}

export async function POST(request: Request) {
  const auth = await getTwitterRequestContext("operator");
  if ("response" in auth) return auth.response;
  const body = (await request.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const admin = createSupabaseAdminClient();
  const organizationId = auth.context.activeOrganization.id;
  let assetIds = Array.isArray(body.assetIds)
    ? [
        ...new Set(
          body.assetIds.filter((id): id is string => typeof id === "string"),
        ),
      ]
    : [];

  if (body.selectAllMatching === true) {
    const filters = filtersFrom(body);
    const countResult = await admin.rpc("twitter_count_gallery_media", {
      p_organization_id: organizationId,
      p_type_filter: filters.type,
      p_situation_filter: filters.status,
      p_group_id: filters.groupId,
      p_ungrouped: filters.ungrouped,
      p_search: filters.search,
    });
    if (countResult.error)
      return NextResponse.json(
        { error: "Não foi possível contar as mídias deste filtro X." },
        { status: 500 },
      );
    const total = Number(countResult.data ?? 0);
    if (body.dryRun === true)
      return NextResponse.json(
        { total },
        { headers: { "Cache-Control": "no-store" } },
      );
    if (total > 50_000)
      return NextResponse.json(
        { error: "Refine o filtro para no máximo 50.000 mídias." },
        { status: 400 },
      );
    const pageResult = await admin.rpc("twitter_gallery_media_page", {
      p_organization_id: organizationId,
      p_limit: 50_001,
      p_cursor_at: null,
      p_cursor_id: null,
      p_type_filter: filters.type,
      p_situation_filter: filters.status,
      p_group_id: filters.groupId,
      p_ungrouped: filters.ungrouped,
      p_search: filters.search,
    });
    if (pageResult.error)
      return NextResponse.json(
        { error: "Não foi possível localizar as mídias deste filtro X." },
        { status: 500 },
      );
    assetIds = ((pageResult.data ?? []) as TwitterGalleryRow[]).map(
      (asset) => asset.id,
    );
  }
  if (!assetIds.length)
    return NextResponse.json(
      { error: "Nenhuma mídia X disponível para exclusão." },
      { status: 404 },
    );
  if (assetIds.length > 50_000)
    return NextResponse.json(
      { error: "Selecione no máximo 50.000 mídias X." },
      { status: 400 },
    );

  const { data: assets, error: assetsError } = await admin
    .from("twitter_media_assets")
    .select("id,storage_path,thumbnail_storage_path")
    .eq("organization_id", organizationId)
    .in("id", assetIds)
    .is("deleted_at", null);
  if (assetsError || !assets?.length)
    return NextResponse.json(
      { error: "As mídias X selecionadas não estão mais disponíveis." },
      { status: 404 },
    );
  const existingIds = assets.map((asset) => asset.id);
  const { error: updateError } = await admin
    .from("twitter_media_assets")
    .update({ status: "deleted", deleted_at: new Date().toISOString() })
    .eq("organization_id", organizationId)
    .in("id", existingIds);
  if (updateError)
    return NextResponse.json(
      { error: "Não foi possível excluir as mídias X." },
      { status: 500 },
    );
  await admin
    .from("twitter_media_group_members")
    .delete()
    .eq("organization_id", organizationId)
    .in("asset_id", existingIds);
  const { data: references } = await admin
    .from("twitter_program_media_set_assets")
    .select("asset_id")
    .in("asset_id", existingIds);
  const retained = new Set((references ?? []).map((row) => row.asset_id));
  const removablePaths = assets
    .filter((asset) => !retained.has(asset.id))
    .flatMap((asset) => [
      asset.storage_path,
      ...(asset.thumbnail_storage_path ? [asset.thumbnail_storage_path] : []),
    ]);
  const storageResult = removablePaths.length
    ? await admin.storage.from("twitter-media").remove(removablePaths)
    : { error: null };
  return NextResponse.json(
    {
      deletedIds: existingIds,
      affectedItemIds: [],
      affectedBatchIds: [],
      warning: retained.size
        ? `${retained.size} arquivo(s) foram preservados porque pertencem a programas X confirmados.`
        : undefined,
      error: storageResult.error
        ? "As mídias foram ocultadas, mas parte da limpeza física será reconciliada."
        : undefined,
    },
    { status: storageResult.error ? 207 : 200 },
  );
}
