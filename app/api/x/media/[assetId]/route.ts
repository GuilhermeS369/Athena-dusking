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
  const { error } = await admin.from('twitter_media_assets').update({ status: 'deleted', deleted_at: new Date().toISOString() })
    .eq('id', asset.id).eq('organization_id', auth.context.activeOrganization.id);
  if (error) return NextResponse.json({ error: 'Não foi possível remover o asset X.' }, { status: 500 });

  // Programas confirmados congelam seus assets. Nesse caso, esconder da galeria
  // não pode remover o objeto usado por itens futuros ou pelo histórico.
  const { count, error: referenceError } = await admin.from('twitter_program_media_set_assets').select('asset_id', { count: 'exact', head: true })
    .eq('asset_id', asset.id);
  if (referenceError) {
    return NextResponse.json({ ok: true, idempotentReplay: false, storageRetained: true, warning: 'Mídia ocultada; objeto preservado por segurança.' });
  }
  if ((count ?? 0) > 0) return NextResponse.json({ ok: true, idempotentReplay: false, storageRetained: true });

  const { error: storageError } = await admin.storage.from('twitter-media').remove([asset.storage_path]);
  return NextResponse.json({
    ok: true,
    idempotentReplay: false,
    storageRetained: Boolean(storageError),
    warning: storageError ? 'Mídia ocultada; a limpeza do objeto será reconciliada depois.' : undefined,
  });
}
