import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createR2SignedUrl, uploadToR2 } from '@/lib/storage/r2-client';
import { removeMediaObjectsEverywhere } from '@/lib/storage/media-storage';

const MAX_THUMBNAIL_SIZE = 2 * 1024 * 1024;
function mediaStorageBackend() {
  return (process.env.MEDIA_STORAGE_BACKEND || 'supabase').toLowerCase();
}
const r2Bucket = process.env.R2_BUCKET_INSTAGRAM_MEDIA || 'instagram-media';

export async function GET(_request: Request, { params }: { params: Promise<{ assetId: string }> }) {
  const { assetId } = await params;
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  const supabase = await createSupabaseServerClient();
  const { data: asset, error } = await supabase
    .from('media_assets')
    .select('id, kind, storage_path')
    .eq('id', assetId)
    .eq('organization_id', context.activeOrganization.id)
    .is('deleted_at', null)
    .maybeSingle();
  if (error || !asset || asset.kind !== 'video') return NextResponse.json({ error: 'Vídeo não encontrado.' }, { status: 404 });
  if (mediaStorageBackend() === 'r2') {
    const videoUrl = await createR2SignedUrl(r2Bucket, asset.storage_path, 60 * 10).catch(() => null);
    if (!videoUrl) return NextResponse.json({ error: 'Não foi possível acessar o arquivo do vídeo.' }, { status: 400 });
    return NextResponse.json({ video_url: videoUrl }, { headers: { 'Cache-Control': 'no-store' } });
  }
  const { data: signed, error: signError } = await supabase.storage.from('instagram-media').createSignedUrl(asset.storage_path, 60 * 10);
  if (signError || !signed?.signedUrl) return NextResponse.json({ error: 'Não foi possível acessar o arquivo do vídeo.' }, { status: 400 });
  return NextResponse.json({ video_url: signed.signedUrl }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request, { params }: { params: Promise<{ assetId: string }> }) {
  const { assetId } = await params;
  const recoveryRequested = request.headers.get('x-thumbnail-recovery') === 'true';
  const context = await getOrganizationContext();
  const organization = context.organizations.find((item) => item.id === context.activeOrganization?.id);
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  if (!organization || !['admin', 'operator'].includes(organization.role)) return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });

  const formData = await request.formData();
  const thumbnail = formData.get('thumbnail');
  if (!(thumbnail instanceof File) || thumbnail.type !== 'image/jpeg' || thumbnail.size <= 0 || thumbnail.size > MAX_THUMBNAIL_SIZE) {
    return NextResponse.json({ error: 'Envie uma miniatura JPEG de até 2 MB.' }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const { data: asset, error: assetError } = await supabase
    .from('media_assets')
    .select('id, kind, thumbnail_storage_path')
    .eq('id', assetId)
    .eq('organization_id', context.activeOrganization.id)
    .is('deleted_at', null)
    .maybeSingle();
  if (assetError || !asset || asset.kind !== 'video') return NextResponse.json({ error: 'Vídeo não encontrado.' }, { status: 404 });

  const storagePath = `${context.activeOrganization.id}/thumbnails/${asset.id}.jpg`;
  const thumbnailBuffer = Buffer.from(await thumbnail.arrayBuffer());
  if (mediaStorageBackend() === 'r2') {
    try {
      await uploadToR2(r2Bucket, storagePath, thumbnailBuffer, 'image/jpeg');
    } catch (uploadError) {
      console.error('[media/thumbnail] Falha ao guardar miniatura', { assetId, recoveryRequested, message: uploadError instanceof Error ? uploadError.message : 'erro desconhecido' });
      return NextResponse.json({ error: `Não foi possível guardar a miniatura: ${uploadError instanceof Error ? uploadError.message : 'erro desconhecido'}` }, { status: 400 });
    }
  } else {
    const { error: uploadError } = await supabase.storage.from('instagram-media').upload(storagePath, thumbnailBuffer, { contentType: 'image/jpeg', upsert: true });
    if (uploadError) {
      console.error('[media/thumbnail] Falha ao guardar miniatura', { assetId, recoveryRequested, message: uploadError.message });
      return NextResponse.json({ error: `Não foi possível guardar a miniatura: ${uploadError.message}` }, { status: 400 });
    }
  }

  const previousStoragePath = asset.thumbnail_storage_path;
  const { error: updateError } = await supabase.from('media_assets').update({ thumbnail_storage_path: storagePath }).eq('id', asset.id);
  if (updateError) {
    console.error('[media/thumbnail] Miniatura enviada, mas não vinculada', { assetId, recoveryRequested, message: updateError.message });
    return NextResponse.json({ error: 'A miniatura foi enviada, mas não pôde ser vinculada ao vídeo.' }, { status: 400 });
  }

  // A miniatura do upload usa o id do item da fila no nome; a recuperação usa o
  // id da mídia. Sem apagar a antiga aqui, cada recuperação deixava um arquivo
  // solto no bucket — foi assim que apareceram ~2,2 mil miniaturas órfãs no R2.
  if (previousStoragePath && previousStoragePath !== storagePath) {
    const { error: removeError } = await removeMediaObjectsEverywhere(supabase, [previousStoragePath]);
    if (removeError) {
      console.warn('[media/thumbnail] Miniatura antiga não pôde ser removida', { assetId, previousStoragePath, message: removeError.message });
    }
  }

  const thumbnailUrl = mediaStorageBackend() === 'r2'
    ? await createR2SignedUrl(r2Bucket, storagePath, 60 * 10).catch(() => null)
    : (await supabase.storage.from('instagram-media').createSignedUrl(storagePath, 60 * 10)).data?.signedUrl ?? null;
  console.info('[media/thumbnail] Miniatura atualizada', { assetId, recoveryRequested, storagePath });
  return NextResponse.json({ thumbnail_url: thumbnailUrl });
}
