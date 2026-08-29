import { NextResponse } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  chunkIds,
  fetchAllRowsByIds,
  runInIdChunks,
} from "@/lib/supabase/chunk";
import { getTwitterRequestContext } from "@/lib/twitter/request-context";
import type { TwitterGalleryRow } from "@/lib/twitter/gallery";

// O teto de linhas do PostgREST (1000) vale para RPC "returns table" também, por
// isso paginamos a galeria pelo cursor keyset que a própria função já expõe.
const GALLERY_PAGE_SIZE = 1_000;
const MAX_FILTER_DELETE_SIZE = 50_000;
// A remoção física recebe a lista de caminhos no corpo; blocos evitam um único
// payload gigante quando a exclusão cobre dezenas de milhares de arquivos.
const STORAGE_REMOVE_CHUNK_SIZE = 500;

type DeletableAsset = {
  id: string;
  storage_path: string;
  thumbnail_storage_path: string | null;
};

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
    if (total > MAX_FILTER_DELETE_SIZE)
      return NextResponse.json(
        { error: "Refine o filtro para no máximo 50.000 mídias." },
        { status: 400 },
      );
    // O p_limit de 50.001 era mentira: o PostgREST corta a resposta em 1.000
    // linhas, então "selecionar todos" contava certo e apagava só as 1.000
    // primeiras, reportando sucesso. A RPC ordena por (created_at, id) desc e
    // aceita esse par como cursor, então dá para percorrer o filtro inteiro.
    const collected: string[] = [];
    let cursorAt: string | null = null;
    let cursorId: string | null = null;
    for (;;) {
      const pageResult = await admin.rpc("twitter_gallery_media_page", {
        p_organization_id: organizationId,
        p_limit: GALLERY_PAGE_SIZE,
        p_cursor_at: cursorAt,
        p_cursor_id: cursorId,
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
      const page = (pageResult.data ?? []) as TwitterGalleryRow[];
      const last = page.at(-1);
      collected.push(...page.map((asset) => asset.id));
      if (page.length < GALLERY_PAGE_SIZE || !last) break;
      if (collected.length > MAX_FILTER_DELETE_SIZE) break;
      cursorAt = last.created_at;
      cursorId = last.id;
    }
    assetIds = collected;
  }
  if (!assetIds.length)
    return NextResponse.json(
      { error: "Nenhuma mídia X disponível para exclusão." },
      { status: 404 },
    );
  if (assetIds.length > MAX_FILTER_DELETE_SIZE)
    return NextResponse.json(
      { error: "Selecione no máximo 50.000 mídias X." },
      { status: 400 },
    );

  // Dezenas de milhares de ids não cabem na URL do GET e a resposta seria
  // cortada em 1.000 linhas de qualquer forma: lemos por blocos.
  const { data: assets, error: assetsError } =
    await fetchAllRowsByIds<DeletableAsset>(assetIds, (chunk, from, to) =>
      admin
        .from("twitter_media_assets")
        .select("id,storage_path,thumbnail_storage_path")
        .eq("organization_id", organizationId)
        .in("id", chunk)
        .is("deleted_at", null)
        .order("id", { ascending: true })
        .range(from, to),
    );
  if (assetsError || !assets.length)
    return NextResponse.json(
      { error: "As mídias X selecionadas não estão mais disponíveis." },
      { status: 404 },
    );
  const existingIds = assets.map((asset) => asset.id);
  const deletedAt = new Date().toISOString();
  const { processed, error: updateError } = await runInIdChunks(
    existingIds,
    (chunk) =>
      admin
        .from("twitter_media_assets")
        .update({ status: "deleted", deleted_at: deletedAt })
        .eq("organization_id", organizationId)
        .in("id", chunk),
  );
  if (updateError)
    return NextResponse.json(
      {
        error: processed
          ? "A exclusão foi parcial: " +
            processed +
            " de " +
            existingIds.length +
            " mídias X foram excluídas."
          : "Não foi possível excluir as mídias X.",
      },
      { status: 500 },
    );
  await runInIdChunks(existingIds, (chunk) =>
    admin
      .from("twitter_media_group_members")
      .delete()
      .eq("organization_id", organizationId)
      .in("asset_id", chunk),
  );
  // Um asset pode aparecer em vários media sets, então este read é 1:N e precisa
  // de ordem determinística para paginar. Se ele falhar não dá para remover nada
  // do storage: uma lista incompleta aqui apagaria arquivos ainda referenciados
  // por programas confirmados.
  const { data: references, error: referencesError } =
    await fetchAllRowsByIds<{ asset_id: string }>(
      existingIds,
      (chunk, from, to) =>
        admin
          .from("twitter_program_media_set_assets")
          .select("asset_id")
          .in("asset_id", chunk)
          .order("asset_id", { ascending: true })
          .order("media_set_id", { ascending: true })
          .order("position", { ascending: true })
          .range(from, to),
    );
  const retained = new Set(references.map((row) => row.asset_id));
  const removablePaths = referencesError
    ? []
    : assets
        .filter((asset) => !retained.has(asset.id))
        .flatMap((asset) => [
          asset.storage_path,
          ...(asset.thumbnail_storage_path
            ? [asset.thumbnail_storage_path]
            : []),
        ]);
  let storageError: unknown = referencesError;
  for (const paths of chunkIds(removablePaths, STORAGE_REMOVE_CHUNK_SIZE)) {
    const { error } = await admin.storage.from("twitter-media").remove(paths);
    if (error) {
      storageError = error;
      break;
    }
  }
  return NextResponse.json(
    {
      deletedIds: existingIds,
      affectedItemIds: [],
      affectedBatchIds: [],
      warning: retained.size
        ? `${retained.size} arquivo(s) foram preservados porque pertencem a programas X confirmados.`
        : undefined,
      error: storageError
        ? "As mídias foram ocultadas, mas parte da limpeza física será reconciliada."
        : undefined,
    },
    { status: storageError ? 207 : 200 },
  );
}
