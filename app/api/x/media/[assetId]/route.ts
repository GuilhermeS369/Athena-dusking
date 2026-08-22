import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { getTwitterRequestContext } from '@/lib/twitter/request-context';

export async function DELETE(_request: Request, { params }: { params: Promise<{ assetId: string }> }) {
  const auth = await getTwitterRequestContext('operator');
  if ('response' in auth) return auth.response;
  const { assetId } = await params;
  const admin = createSupabaseAdminClient();
  const { data: asset } = await admin.from('twitter_media_assets').select('id,storage_path').eq('id', assetId)
    .eq('organization_id', auth.context.activeOrganization.id).is('deleted_at', null).maybeSingle();
  if (!asset) return NextResponse.json({ ok: true, idempotentReplay: true });
  const { error: storageError } = await admin.storage.from('twitter-media').remove([asset.storage_path]);
  if (storageError) return NextResponse.json({ error: 'Não foi possível remover o objeto do Storage.' }, { status: 409 });
  const { error } = await admin.from('twitter_media_assets').update({ status: 'deleted', deleted_at: new Date().toISOString() })
    .eq('id', asset.id).eq('organization_id', auth.context.activeOrganization.id);
  if (error) return NextResponse.json({ error: 'Não foi possível remover o asset X.' }, { status: 500 });
  return NextResponse.json({ ok: true, idempotentReplay: false });
}
