import { NextResponse } from 'next/server';

import { loadMetaAppSigners } from '@/lib/integrations/meta-app-signers';
import { dataDeletionConfirmationCode, parseMetaSignedRequest } from '@/lib/integrations/meta-webhook';
import { softDeleteProfileAnalytics } from '@/lib/integrations/zernio-analytics';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

/**
 * Callback de solicitação de exclusão de dados. A Meta chama esta URL com um
 * `signed_request` e espera de volta `{ url, confirmation_code }` — a URL é a
 * página onde a pessoa acompanha o pedido, e o código identifica esse pedido.
 *
 * A exclusão roda em todas as organizações que tenham o perfil conectado: quem
 * pede exclusão pede para o serviço inteiro, não para um cliente específico.
 * O caminho é o mesmo da exclusão manual em `/perfis` — sai dos grupos, o
 * perfil recebe `deleted_at` e os snapshots de analytics são removidos.
 */
export async function POST(request: Request) {
  const body = new URLSearchParams(await request.text());
  const parsed = parseMetaSignedRequest(body.get('signed_request'), await loadMetaAppSigners());

  if (!parsed) {
    console.warn('[meta-data-deletion] invalid_signed_request');
    return NextResponse.json({ error: 'signed_request inválido.' }, { status: 401 });
  }

  const confirmationCode = dataDeletionConfirmationCode(parsed.signer, parsed.userId);
  const statusUrl = new URL('/exclusao-de-dados', new URL(request.url).origin);
  statusUrl.searchParams.set('code', confirmationCode);

  const admin = createSupabaseAdminClient();

  // Um perfil por organização, no máximo: `instagram_profiles` é única em
  // (organization_id, instagram_user_id) e a busca fixa o instagram_user_id.
  const { data: profiles, error: lookupError } = await admin
    .from('instagram_profiles')
    .select('id, organization_id')
    .eq('instagram_user_id', parsed.userId)
    .is('deleted_at', null);

  if (lookupError) {
    console.error('[meta-data-deletion] lookup_failed', {
      appId: parsed.signer.appId,
      message: lookupError.message,
    });

    return NextResponse.json({ error: 'Falha ao localizar os dados.' }, { status: 500 });
  }

  for (const profile of profiles ?? []) {
    const { error: membershipError } = await admin
      .from('profile_group_members')
      .delete()
      .eq('organization_id', profile.organization_id)
      .eq('profile_id', profile.id);

    if (membershipError) {
      console.error('[meta-data-deletion] membership_delete_failed', {
        profileId: profile.id,
        message: membershipError.message,
      });

      return NextResponse.json({ error: 'Falha ao remover o perfil dos grupos.' }, { status: 500 });
    }

    const { error: deleteError } = await admin
      .from('instagram_profiles')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', profile.id)
      .is('deleted_at', null);

    if (deleteError) {
      console.error('[meta-data-deletion] profile_delete_failed', {
        profileId: profile.id,
        message: deleteError.message,
      });

      return NextResponse.json({ error: 'Falha ao excluir o perfil.' }, { status: 500 });
    }

    await softDeleteProfileAnalytics(profile.id).catch((error: unknown) => {
      console.error('[meta-data-deletion] analytics_cleanup_failed', { profileId: profile.id, error });
    });
  }

  console.info('[meta-data-deletion] applied', {
    appId: parsed.signer.appId,
    instagramUserId: parsed.userId,
    profiles: profiles?.length ?? 0,
    confirmationCode,
  });

  return NextResponse.json({
    url: statusUrl.toString(),
    confirmation_code: confirmationCode,
  });
}
