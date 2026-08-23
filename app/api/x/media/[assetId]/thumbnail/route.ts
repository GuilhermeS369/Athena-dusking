import { NextResponse } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getTwitterRequestContext } from "@/lib/twitter/request-context";

const maxThumbnailBytes = 2 * 1024 * 1024;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ assetId: string }> },
) {
  const auth = await getTwitterRequestContext();
  if ("response" in auth) return auth.response;
  const { assetId } = await params;
  const admin = createSupabaseAdminClient();
  const { data: asset } = await admin
    .from("twitter_media_assets")
    .select("storage_path,media_kind")
    .eq("id", assetId)
    .eq("organization_id", auth.context.activeOrganization.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!asset || asset.media_kind !== "video")
    return NextResponse.json(
      { error: "Vídeo X não encontrado." },
      { status: 404 },
    );
  const { data: signed, error } = await admin.storage
    .from("twitter-media")
    .createSignedUrl(asset.storage_path, 60 * 10);
  return error || !signed?.signedUrl
    ? NextResponse.json(
        { error: "Não foi possível acessar temporariamente o vídeo X." },
        { status: 400 },
      )
    : NextResponse.json(
        { video_url: signed.signedUrl },
        { headers: { "Cache-Control": "no-store" } },
      );
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ assetId: string }> },
) {
  const auth = await getTwitterRequestContext("operator");
  if ("response" in auth) return auth.response;
  const { assetId } = await params;
  const formData = await request.formData();
  const thumbnail = formData.get("thumbnail");
  if (
    !(thumbnail instanceof File) ||
    thumbnail.type !== "image/jpeg" ||
    thumbnail.size < 1 ||
    thumbnail.size > maxThumbnailBytes
  )
    return NextResponse.json(
      { error: "Envie uma miniatura JPEG de até 2 MB." },
      { status: 400 },
    );
  const admin = createSupabaseAdminClient();
  const organizationId = auth.context.activeOrganization.id;
  const { data: asset } = await admin
    .from("twitter_media_assets")
    .select("id,media_kind")
    .eq("id", assetId)
    .eq("organization_id", organizationId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!asset || asset.media_kind !== "video")
    return NextResponse.json(
      { error: "Vídeo X não encontrado." },
      { status: 404 },
    );
  const storagePath = `${organizationId}/thumbnails/${asset.id}.jpg`;
  const { error: uploadError } = await admin.storage
    .from("twitter-media")
    .upload(storagePath, Buffer.from(await thumbnail.arrayBuffer()), {
      contentType: "image/jpeg",
      upsert: true,
    });
  if (uploadError)
    return NextResponse.json(
      { error: "Não foi possível armazenar a miniatura X." },
      { status: 400 },
    );
  const { error: updateError } = await admin
    .from("twitter_media_assets")
    .update({ thumbnail_storage_path: storagePath })
    .eq("id", asset.id)
    .eq("organization_id", organizationId);
  if (updateError)
    return NextResponse.json(
      { error: "A miniatura subiu, mas não pôde ser vinculada ao vídeo X." },
      { status: 500 },
    );
  const { data: signed } = await admin.storage
    .from("twitter-media")
    .createSignedUrl(storagePath, 60 * 10);
  return NextResponse.json({ thumbnail_url: signed?.signedUrl ?? null });
}
