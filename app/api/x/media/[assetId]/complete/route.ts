import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { getTwitterRequestContext } from '@/lib/twitter/request-context';

export async function POST(_request: Request, { params }: { params: Promise<{ assetId: string }> }) {
  const auth = await getTwitterRequestContext('operator');
  if ('response' in auth) return auth.response;
  const { assetId } = await params;
  const admin = createSupabaseAdminClient();
  const { data: asset } = await admin.from('twitter_media_assets').select('*').eq('id', assetId)
    .eq('organization_id', auth.context.activeOrganization.id).is('deleted_at', null).maybeSingle();
  if (!asset) return NextResponse.json({ error: 'Asset X não encontrado.' }, { status: 404 });
  const slash = asset.storage_path.lastIndexOf('/');
  const folder = asset.storage_path.slice(0, slash);
  const fileName = asset.storage_path.slice(slash + 1);
  const { data: objects, error: storageError } = await admin.storage.from('twitter-media').list(folder, { search: fileName, limit: 10 });
  const object = objects?.find((item) => item.name === fileName);
  const actualSize = Number(object?.metadata?.size ?? 0);
  if (storageError || !object || actualSize !== Number(asset.byte_size)) {
    return NextResponse.json({ error: 'O objeto enviado não corresponde à reserva.' }, { status: 409 });
  }
  const { error } = await admin.from('twitter_media_assets').update({ status: 'ready', failure_code: null, failure_message: null })
    .eq('id', asset.id).eq('organization_id', auth.context.activeOrganization.id);
  if (error) return NextResponse.json({ error: 'Não foi possível concluir o asset X.' }, { status: 500 });
  return NextResponse.json({ ok: true, assetId });
}
