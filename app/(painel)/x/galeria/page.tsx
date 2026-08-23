import { notFound, redirect } from "next/navigation";

import GalleryClient from "@/app/galeria/gallery-client";
import { getOrganizationContext } from "@/lib/organizations/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isTwitterModuleEnabled } from "@/lib/twitter/feature";
import type { TwitterGalleryRow } from "@/lib/twitter/gallery";

export const dynamic = "force-dynamic";

export default async function TwitterGalleryPage() {
  const context = await getOrganizationContext();
  if (!context.user) redirect("/login");
  if (!context.activeOrganization) redirect("/onboarding");
  if (!isTwitterModuleEnabled(context.activeOrganization.id)) notFound();

  const admin = createSupabaseAdminClient();
  const organizationId = context.activeOrganization.id;
  const [pageResult, groupsResult, totalResult] = await Promise.all([
    admin.rpc("twitter_gallery_media_page", {
      p_organization_id: organizationId,
      p_limit: 25,
      p_cursor_at: null,
      p_cursor_id: null,
      p_type_filter: "all",
      p_situation_filter: "all",
      p_group_id: null,
      p_ungrouped: false,
      p_search: "",
    }),
    admin
      .from("twitter_groups")
      .select("id,name")
      .eq("organization_id", organizationId)
      .is("deleted_at", null)
      .order("name"),
    admin
      .from("twitter_media_assets")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .is("deleted_at", null),
  ]);
  if (pageResult.error || groupsResult.error || totalResult.error)
    throw new Error(
      "Não foi possível carregar a Galeria X. Aplique a migração 250 de grupos de perfis.",
    );

  const allPageRows = (pageResult.data ?? []) as TwitterGalleryRow[];
  const pageRows = allPageRows.slice(0, 24);
  const assetIds = pageRows.map((asset) => asset.id);
  const { data: memberships, error: membershipsError } = assetIds.length
    ? await admin
        .from("twitter_media_group_members")
        .select("group_id,asset_id")
        .eq("organization_id", organizationId)
        .in("asset_id", assetIds)
    : { data: [], error: null };
  if (membershipsError)
    throw new Error("Não foi possível carregar os grupos das mídias X.");

  const assets = await Promise.all(
    pageRows.map(async (asset) => {
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
        kind: asset.media_kind as "image" | "gif" | "video",
        size_bytes: Number(asset.byte_size),
        status: asset.status as
          "uploaded" | "processing" | "ready" | "failed" | "deleted",
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
  const last = pageRows.at(-1);
  const hasMore = allPageRows.length > 24;
  const nextCursor =
    hasMore && last
      ? Buffer.from(
          JSON.stringify({ createdAt: last.created_at, id: last.id }),
        ).toString("base64url")
      : null;

  return (
    <GalleryClient
      platform="twitter"
      activeOrganization={context.activeOrganization}
      assets={assets}
      initialHasMoreAssets={hasMore}
      initialNextCursor={nextCursor}
      initialTotal={totalResult.count ?? 0}
      groups={(groupsResult.data ?? []).map((group) => ({
        ...group,
        consumption_mode: "reusable" as const,
      }))}
      assignments={(memberships ?? []).map((membership) => ({
        media_asset_id: membership.asset_id,
        group_id: membership.group_id,
      }))}
    />
  );
}
