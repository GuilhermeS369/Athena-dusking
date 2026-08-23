import { NextResponse } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getTwitterRequestContext } from "@/lib/twitter/request-context";
import type { TwitterGalleryRow } from "@/lib/twitter/gallery";

const situationFilters = new Set([
  "all",
  "schedulable",
  "unposted",
  "scheduled",
  "posted",
  "posted_scheduled",
  "uploaded",
  "processing",
  "ready",
  "failed",
]);
const typeFilters = new Set(["all", "image", "gif", "video"]);

function decodeCursor(value: string | null) {
  if (!value) return null;
  try {
    const cursor = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as { createdAt?: unknown; id?: unknown };
    if (typeof cursor.createdAt !== "string" || typeof cursor.id !== "string")
      return null;
    return { createdAt: cursor.createdAt, id: cursor.id };
  } catch {
    return null;
  }
}

function encodeCursor(asset: { created_at: string; id: string }) {
  return Buffer.from(
    JSON.stringify({ createdAt: asset.created_at, id: asset.id }),
  ).toString("base64url");
}

export async function GET(request: Request) {
  const auth = await getTwitterRequestContext();
  if ("response" in auth) return auth.response;
  const url = new URL(request.url);
  const rawCursor = url.searchParams.get("cursor");
  const cursor = decodeCursor(rawCursor);
  if (rawCursor && !cursor)
    return NextResponse.json(
      { error: "Cursor da Galeria X inválido." },
      { status: 400 },
    );

  const limit = Math.max(
    1,
    Math.min(100, Number.parseInt(url.searchParams.get("limit") ?? "30", 10)),
  );
  const type = typeFilters.has(url.searchParams.get("type") ?? "all")
    ? (url.searchParams.get("type") ?? "all")
    : "all";
  const status = situationFilters.has(url.searchParams.get("status") ?? "all")
    ? (url.searchParams.get("status") ?? "all")
    : "all";
  const group = url.searchParams.get("group") ?? "all";
  const groupId = group !== "all" && group !== "none" ? group : null;
  const ungrouped = group === "none";
  const search = (url.searchParams.get("search") ?? "").trim().slice(0, 100);
  const admin = createSupabaseAdminClient();
  const organizationId = auth.context.activeOrganization.id;
  const [pageResult, totalResult] = await Promise.all([
    admin.rpc("twitter_gallery_media_page", {
      p_organization_id: organizationId,
      p_limit: limit + 1,
      p_cursor_at: cursor?.createdAt ?? null,
      p_cursor_id: cursor?.id ?? null,
      p_type_filter: type,
      p_situation_filter: status,
      p_group_id: groupId,
      p_ungrouped: ungrouped,
      p_search: search,
    }),
    admin.rpc("twitter_count_gallery_media", {
      p_organization_id: organizationId,
      p_type_filter: type,
      p_situation_filter: status,
      p_group_id: groupId,
      p_ungrouped: ungrouped,
      p_search: search,
    }),
  ]);
  if (pageResult.error || totalResult.error)
    return NextResponse.json(
      { error: "Não foi possível consultar a Galeria X." },
      { status: 500 },
    );
  const rows = (pageResult.data ?? []) as TwitterGalleryRow[];
  const page = rows.slice(0, limit);
  const assetIds = page.map((asset) => asset.id);
  const { data: memberships, error: membershipError } = assetIds.length
    ? await admin
        .from("twitter_media_group_members")
        .select("group_id,asset_id")
        .eq("organization_id", organizationId)
        .in("asset_id", assetIds)
    : { data: [], error: null };
  if (membershipError)
    return NextResponse.json(
      { error: "Não foi possível consultar os grupos da Galeria X." },
      { status: 500 },
    );

  const assets = await Promise.all(
    page.map(async (asset) => {
      const [signed, thumbnail] = await Promise.all([
        admin.storage.from("twitter-media").createSignedUrl(
          asset.storage_path,
          60 * 30,
          asset.media_kind === "image"
            ? {
                transform: {
                  width: 240,
                  height: 240,
                  resize: "contain",
                  quality: 60,
                  format: "origin",
                },
              }
            : undefined,
        ),
        asset.thumbnail_storage_path
          ? admin.storage
              .from("twitter-media")
              .createSignedUrl(asset.thumbnail_storage_path, 60 * 10)
          : Promise.resolve({ data: null }),
      ]);
      return {
        id: asset.id,
        original_name: asset.original_name,
        mime_type: asset.mime_type,
        kind: asset.media_kind,
        size_bytes: Number(asset.byte_size),
        status: asset.status,
        processing_error: asset.processing_error,
        signed_url: signed.data?.signedUrl ?? null,
        thumbnail_url: thumbnail.data?.signedUrl ?? null,
        group_ids: (memberships ?? [])
          .filter((membership) => membership.asset_id === asset.id)
          .map((membership) => membership.group_id),
        first_published_at: asset.first_published_at,
        publication_state: asset.scheduled_count
          ? {
              scheduled_count: Number(asset.scheduled_count),
              next_scheduled_at: asset.next_scheduled_at,
            }
          : null,
        created_at: asset.created_at,
      };
    }),
  );
  const last = page.at(-1);
  return NextResponse.json(
    {
      assets,
      hasMore: rows.length > limit,
      nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
      total: Number(totalResult.data ?? 0),
    },
    {
      headers: {
        "Cache-Control": "private, max-age=30, stale-while-revalidate=60",
      },
    },
  );
}
