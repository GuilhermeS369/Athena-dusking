import { NextResponse } from 'next/server';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

const TYPES = new Map([['image/jpeg', 'image'], ['image/png', 'image'], ['image/webp', 'image'], ['video/mp4', 'video'], ['video/quicktime', 'video']]);

async function assignAssetToUploadGroup(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  organizationId: string,
  assetId: string,
  groupId: string | null,
) {
  if (!groupId) return [];
  const { data, error } = await supabase.rpc('update_media_group_assignments_bulk', {
    p_organization_id: organizationId,
    p_media_asset_ids: [assetId],
    p_group_ids: [groupId],
    p_action: 'add',
  });
  if (error) {
    console.warn('[media/complete] Upload registrado, mas falhou ao associar grupo', { assetId, groupId, message: error.message, code: error.code });
    return [];
  }
  return [...new Set(((data ?? []) as Array<{ media_asset_id: string; group_id: string }>)
    .filter((assignment) => assignment.media_asset_id === assetId)
    .map((assignment) => assignment.group_id))];
}

export async function POST(request: Request) {
  const context = await getOrganizationContext();
  const organization = context.organizations.find((item) => item.id === context.activeOrganization?.id);
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  if (!organization || !['admin', 'operator'].includes(organization.role)) return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });
  const organizationId = context.activeOrganization.id;

  try {
    const body = await request.json() as { storagePath?: string; thumbnailStoragePath?: string | null; originalName?: string; mimeType?: string; sizeBytes?: number; checksum?: string; groupId?: string | null };
    const kind = body.mimeType ? TYPES.get(body.mimeType) : undefined;
    const prefix = `${organizationId}/`;
    const hasValidThumbnail = !body.thumbnailStoragePath || body.thumbnailStoragePath.startsWith(`${prefix}thumbnails/`);
    const uploadGroupId = typeof body.groupId === 'string' && body.groupId.trim() ? body.groupId : null;
    if (!body.storagePath || !body.storagePath.startsWith(prefix) || !body.originalName || !kind || !body.sizeBytes || body.sizeBytes > 50 * 1024 * 1024 || !/^[a-f0-9]{64}$/i.test(body.checksum ?? '') || !hasValidThumbnail || (kind === 'video' && !body.thumbnailStoragePath)) {
      return NextResponse.json({ error: 'Metadados inválidos ou arquivo acima do limite de 50 MB.' }, { status: 400 });
    }
    const supabase = await createSupabaseServerClient();
    const checksum = body.checksum!.toLowerCase();
    const { data: existing } = await supabase.from('media_assets').select('id, original_name, mime_type, kind, size_bytes, width, height, duration_ms, status, processing_error, storage_path, thumbnail_storage_path, first_published_at, created_at, updated_at, deleted_at, deletion_requested_at').eq('organization_id', organizationId).eq('checksum_sha256', checksum).maybeSingle();
    if (existing) {
      const uploadedStoragePaths = [body.storagePath, ...(body.thumbnailStoragePath ? [body.thumbnailStoragePath] : [])];
      if (existing.deletion_requested_at) {
        await supabase.storage.from('instagram-media').remove(uploadedStoragePaths);
        return NextResponse.json({ error: 'Esta mídia já está em uma fila de exclusão. Aguarde a exclusão terminar antes de reenviar o mesmo arquivo.' }, { status: 409 });
      }

      const storageExists = existing.deleted_at || existing.deletion_requested_at
        ? { data: false, error: null }
        : await supabase.rpc('media_asset_has_storage_object', { p_storage_path: existing.storage_path });

      if (storageExists.error) {
        await supabase.storage.from('instagram-media').remove(uploadedStoragePaths);
        return NextResponse.json({ error: `Não foi possível verificar se o arquivo já existente ainda está no storage: ${storageExists.error.message}` }, { status: 500 });
      }

      if (!storageExists.data) {
        const { error: deleteError } = await supabase
          .from('media_assets')
          .delete()
          .eq('id', existing.id)
          .eq('organization_id', organizationId);

        if (deleteError) {
          const quarantineChecksum = `${crypto.randomUUID().replace(/-/g, '')}${crypto.randomUUID().replace(/-/g, '')}`.slice(0, 64);
          const { error: quarantineError } = await supabase
            .from('media_assets')
            .update({ checksum_sha256: quarantineChecksum, status: 'failed', processing_error: `Registro antigo quebrado liberado para reenvio em ${new Date().toISOString()}: ${deleteError.message}`, deleted_at: new Date().toISOString() })
            .eq('id', existing.id)
            .eq('organization_id', organizationId);

          if (quarantineError) {
            await supabase.storage.from('instagram-media').remove(uploadedStoragePaths);
            return NextResponse.json({ error: `Existe um registro antigo quebrado deste arquivo e ele não pôde liberar o checksum automaticamente: ${quarantineError.message}.` }, { status: 409 });
          }
        }
      } else {
        const disposableStoragePaths = uploadedStoragePaths.filter((path) => path !== existing.storage_path && path !== existing.thumbnail_storage_path);
        if (disposableStoragePaths.length) await supabase.storage.from('instagram-media').remove(disposableStoragePaths);
        const { data: renamedExisting, error: renameExistingError } = await supabase
          .from('media_assets')
          .update({ original_name: body.originalName.slice(0, 255), mime_type: body.mimeType, kind, size_bytes: body.sizeBytes, status: 'ready', processing_error: null })
          .eq('id', existing.id)
          .eq('organization_id', organizationId)
          .is('deletion_requested_at', null)
          .select('id, original_name, mime_type, kind, size_bytes, width, height, duration_ms, status, processing_error, storage_path, thumbnail_storage_path, first_published_at, created_at, updated_at')
          .single();
        if (renameExistingError || !renamedExisting) return NextResponse.json({ error: `O arquivo já existia, mas não pôde ser atualizado para aparecer com o nome reenviado: ${renameExistingError?.message ?? 'erro no banco'}.` }, { status: 400 });
        const [signed, thumbnailSigned] = await Promise.all([
          supabase.storage.from('instagram-media').createSignedUrl(renamedExisting.storage_path, 600),
          renamedExisting.thumbnail_storage_path ? supabase.storage.from('instagram-media').createSignedUrl(renamedExisting.thumbnail_storage_path, 600) : Promise.resolve({ data: null }),
        ]);
        const groupIds = await assignAssetToUploadGroup(supabase, organizationId, renamedExisting.id, uploadGroupId);
        return NextResponse.json({ asset: { ...renamedExisting, signed_url: signed.data?.signedUrl ?? null, thumbnail_url: thumbnailSigned.data?.signedUrl ?? null, group_ids: groupIds }, duplicated: true });
      }
    }
    const { data: asset, error } = await supabase.from('media_assets').insert({ organization_id: organizationId, uploaded_by: context.user.id, storage_path: body.storagePath, thumbnail_storage_path: body.thumbnailStoragePath ?? null, original_name: body.originalName.slice(0, 255), mime_type: body.mimeType, kind, size_bytes: body.sizeBytes, checksum_sha256: checksum, status: 'ready' }).select('id, original_name, mime_type, kind, size_bytes, width, height, duration_ms, status, processing_error, storage_path, thumbnail_storage_path, first_published_at, created_at, updated_at').single();
    if (error || !asset) return NextResponse.json({ error: `O arquivo subiu, mas falhou ao registrar na galeria: ${error?.message ?? 'erro no banco'}.` }, { status: 400 });
    const [signed, thumbnailSigned] = await Promise.all([
      supabase.storage.from('instagram-media').createSignedUrl(body.storagePath, 600),
      body.thumbnailStoragePath ? supabase.storage.from('instagram-media').createSignedUrl(body.thumbnailStoragePath, 600) : Promise.resolve({ data: null }),
    ]);
    const groupIds = await assignAssetToUploadGroup(supabase, organizationId, asset.id, uploadGroupId);
    return NextResponse.json({ asset: { ...asset, signed_url: signed.data?.signedUrl ?? null, thumbnail_url: thumbnailSigned.data?.signedUrl ?? null, group_ids: groupIds } }, { status: 201 });
  } catch (error) { return NextResponse.json({ error: `Não foi possível concluir o upload direto: ${error instanceof Error ? error.message : 'erro inesperado'}.` }, { status: 400 }); }
}
