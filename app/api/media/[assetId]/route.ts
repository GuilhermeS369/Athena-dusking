import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

type DeletedMediaResult = {
  media_asset_id: string;
  storage_path: string;
  thumbnail_storage_path: string | null;
  affected_item_ids: string[] | null;
  affected_batch_ids: string[] | null;
};

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ assetId: string }> },
) {
  const { assetId } = await params;
  const context = await getOrganizationContext();
  const organization = context.organizations.find(
    (item) => item.id === context.activeOrganization?.id,
  );

  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }

  if (!organization || !['admin', 'operator'].includes(organization.role)) {
    return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });
  }

  const supabase = await createSupabaseServerClient();
  const { data, error: deleteError } = await supabase.rpc('delete_media_assets_and_remove_publication_items', {
    p_organization_id: context.activeOrganization.id,
    p_media_asset_ids: [assetId],
  });
  const deletedRows = (data ?? []) as DeletedMediaResult[];
  const asset = deletedRows[0];

  if (deleteError) {
    return NextResponse.json({ error: deleteError.message || 'Não foi possível excluir a mídia.' }, { status: deleteError.code === '42501' ? 403 : 400 });
  }
  if (!asset) {
    return NextResponse.json({ error: 'Mídia não encontrada.' }, { status: 404 });
  }

  const storagePaths = [...new Set([asset.storage_path, ...(asset.thumbnail_storage_path ? [asset.thumbnail_storage_path] : [])])];
  const { error: storageError } = await supabase.storage
    .from('instagram-media')
    .remove(storagePaths);

  const responseBody = {
    ok: true,
    deletedIds: [asset.media_asset_id],
    affectedItemIds: asset.affected_item_ids ?? [],
    affectedBatchIds: asset.affected_batch_ids ?? [],
  };

  if (storageError) {
    return NextResponse.json({ ...responseBody, error: 'Mídia apagada da galeria, mas o arquivo físico não foi removido.' }, { status: 207 });
  }

  return NextResponse.json(responseBody);
}
