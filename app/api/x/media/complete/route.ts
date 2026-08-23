import { NextResponse } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { validateTwitterMedia } from "@/lib/twitter/media";
import { getTwitterRequestContext } from "@/lib/twitter/request-context";

async function storageObjectExists(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  storagePath: string,
) {
  const slash = storagePath.lastIndexOf("/");
  const folder = storagePath.slice(0, slash);
  const fileName = storagePath.slice(slash + 1);
  const { data, error } = await admin.storage
    .from("twitter-media")
    .list(folder, { search: fileName, limit: 10 });
  const object = data?.find((item) => item.name === fileName);
  return {
    exists: !error && Boolean(object),
    size: Number(object?.metadata?.size ?? 0),
    error,
  };
}

export async function POST(request: Request) {
  const auth = await getTwitterRequestContext("operator");
  if ("response" in auth) return auth.response;
  const body = (await request.json().catch(() => ({}))) as {
    storagePath?: unknown;
    thumbnailStoragePath?: unknown;
    originalName?: unknown;
    mimeType?: unknown;
    sizeBytes?: unknown;
    checksum?: unknown;
    groupId?: unknown;
  };
  const organizationId = auth.context.activeOrganization.id;
  const storagePath =
    typeof body.storagePath === "string" ? body.storagePath : "";
  const thumbnailStoragePath =
    typeof body.thumbnailStoragePath === "string"
      ? body.thumbnailStoragePath
      : null;
  const originalName =
    typeof body.originalName === "string"
      ? body.originalName.trim().slice(0, 255)
      : "";
  const mimeType = typeof body.mimeType === "string" ? body.mimeType : "";
  const sizeBytes = Number(body.sizeBytes);
  const checksum =
    typeof body.checksum === "string" ? body.checksum.toLowerCase() : "";
  const groupId =
    typeof body.groupId === "string" && body.groupId ? body.groupId : null;
  const validation = validateTwitterMedia({ type: mimeType, size: sizeBytes });
  const prefix = `${organizationId}/`;
  if (
    !validation.valid ||
    !originalName ||
    !storagePath.startsWith(prefix) ||
    !/^[a-f0-9]{64}$/.test(checksum) ||
    (thumbnailStoragePath !== null &&
      !thumbnailStoragePath.startsWith(`${prefix}thumbnails/`)) ||
    (validation.valid && validation.kind === "video" && !thumbnailStoragePath)
  )
    return NextResponse.json(
      { error: "Metadados do upload X são inválidos." },
      { status: 400 },
    );

  const admin = createSupabaseAdminClient();
  const uploadedPaths = [
    storagePath,
    ...(thumbnailStoragePath ? [thumbnailStoragePath] : []),
  ];
  const uploadedObject = await storageObjectExists(admin, storagePath);
  if (
    uploadedObject.error ||
    !uploadedObject.exists ||
    uploadedObject.size !== sizeBytes
  )
    return NextResponse.json(
      { error: "O arquivo no Storage não corresponde ao upload X informado." },
      { status: 409 },
    );
  const { data: existing, error: existingError } = await admin
    .from("twitter_media_assets")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("sha256", checksum)
    .maybeSingle();
  if (existingError)
    return NextResponse.json(
      { error: "Não foi possível verificar o reaproveitamento da mídia X." },
      { status: 500 },
    );

  let asset;
  let duplicated = false;
  if (existing) {
    if (existing.deletion_requested_at) {
      await admin.storage.from("twitter-media").remove(uploadedPaths);
      return NextResponse.json(
        { error: "Esta mídia já está em uma fila de exclusão." },
        { status: 409 },
      );
    }
    const oldObject = await storageObjectExists(admin, existing.storage_path);
    if (oldObject.error)
      return NextResponse.json(
        { error: "Não foi possível validar o arquivo X já existente." },
        { status: 500 },
      );
    if (oldObject.exists) {
      duplicated = true;
      const disposable = uploadedPaths.filter(
        (path) =>
          path !== existing.storage_path &&
          path !== existing.thumbnail_storage_path &&
          path !==
            (existing.thumbnail_storage_path ? null : thumbnailStoragePath),
      );
      if (disposable.length)
        await admin.storage.from("twitter-media").remove(disposable);
      const { data, error } = await admin
        .from("twitter_media_assets")
        .update({
          original_name: originalName,
          mime_type: mimeType,
          media_kind: validation.kind,
          byte_size: sizeBytes,
          status: "ready",
          failure_code: null,
          failure_message: null,
          thumbnail_storage_path:
            existing.thumbnail_storage_path ?? thumbnailStoragePath,
          deleted_at: null,
          deletion_requested_at: null,
        })
        .eq("id", existing.id)
        .eq("organization_id", organizationId)
        .select("*")
        .single();
      if (error || !data)
        return NextResponse.json(
          { error: "A mídia X existe, mas não pôde ser reaproveitada." },
          { status: 409 },
        );
      asset = data;
    } else {
      const { data, error } = await admin
        .from("twitter_media_assets")
        .update({
          storage_path: storagePath,
          thumbnail_storage_path: thumbnailStoragePath,
          original_name: originalName,
          mime_type: mimeType,
          media_kind: validation.kind,
          byte_size: sizeBytes,
          status: "ready",
          failure_code: null,
          failure_message: null,
          deleted_at: null,
          deletion_requested_at: null,
        })
        .eq("id", existing.id)
        .eq("organization_id", organizationId)
        .select("*")
        .single();
      if (error || !data)
        return NextResponse.json(
          { error: "Não foi possível recuperar a mídia X antiga." },
          { status: 409 },
        );
      asset = data;
    }
  } else {
    const { data, error } = await admin
      .from("twitter_media_assets")
      .insert({
        organization_id: organizationId,
        storage_path: storagePath,
        thumbnail_storage_path: thumbnailStoragePath,
        original_name: originalName,
        mime_type: mimeType,
        media_kind: validation.kind,
        byte_size: sizeBytes,
        sha256: checksum,
        status: "ready",
        created_by: auth.context.user.id,
      })
      .select("*")
      .single();
    if (error?.code === "23505") {
      const { data: concurrent } = await admin
        .from("twitter_media_assets")
        .select("*")
        .eq("organization_id", organizationId)
        .eq("sha256", checksum)
        .is("deleted_at", null)
        .maybeSingle();
      if (concurrent) {
        duplicated = true;
        asset = concurrent;
        await admin.storage.from("twitter-media").remove(uploadedPaths);
      }
    }
    if (!asset && (error || !data)) {
      await admin.storage.from("twitter-media").remove(uploadedPaths);
      return NextResponse.json(
        { error: "O arquivo subiu, mas não pôde ser registrado na Galeria X." },
        { status: 409 },
      );
    }
    if (!asset) asset = data;
  }

  let groupIds: string[] = [];
  if (groupId) {
    const { data: assignments, error } = await admin.rpc(
      "twitter_update_media_group_assignments_bulk",
      {
        p_organization_id: organizationId,
        p_media_asset_ids: [asset.id],
        p_group_ids: [groupId],
        p_action: "add",
        p_actor_user_id: auth.context.user.id,
      },
    );
    if (!error)
      groupIds = (assignments ?? []).map(
        (assignment: { group_id: string }) => assignment.group_id,
      );
  }
  if (!groupIds.length) {
    const { data: memberships } = await admin
      .from("twitter_media_group_members")
      .select("group_id")
      .eq("organization_id", organizationId)
      .eq("asset_id", asset.id);
    groupIds = (memberships ?? []).map((membership) => membership.group_id);
  }
  const [signed, thumbnail] = await Promise.all([
    admin.storage.from("twitter-media").createSignedUrl(
      asset.storage_path,
      60 * 10,
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
  return NextResponse.json(
    {
      asset: {
        id: asset.id,
        original_name: asset.original_name,
        mime_type: asset.mime_type,
        kind: asset.media_kind,
        size_bytes: Number(asset.byte_size),
        status: asset.status,
        processing_error: null,
        signed_url: signed.data?.signedUrl ?? null,
        thumbnail_url: thumbnail.data?.signedUrl ?? null,
        group_ids: groupIds,
        first_published_at: asset.first_published_at,
        publication_state: null,
        created_at: asset.created_at,
      },
      duplicated,
    },
    { status: duplicated ? 200 : 201 },
  );
}
