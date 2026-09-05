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
 *
 * A contenção é a mesma da exclusão pedida em /perfis: além de sair dos grupos e
 * receber `deleted_at`, o perfil tem a fila agendada cancelada. Antes isso não
 * acontecia, e as publicações já marcadas continuavam vivas apontando para um
 * perfil que não existia mais.
 *
 * O QUE ESTE CAMINHO NÃO FAZ, e é decisão consciente: não grava incidente de
 * vaga presa. São duas razões que apontam para o mesmo lado. A primeira é que a
 * vaga não fica presa — quem dispara este callback é a própria Meta, porque a
 * pessoa retirou o app nas configurações dela; a conexão já está sendo desfeita
 * do lado de lá, então não há nada para o operador apagar no Meta Developers. A
 * segunda é que o incidente guarda `username_snapshot`, e criar um registro novo
 * com o @ de quem acabou de pedir exclusão de dados contraria o próprio pedido
 * que estamos atendendo.
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
    // `p_finalize_local` cuida do desvínculo de grupo e do `deleted_at` que
    // esta rota fazia à mão; o resto da função é o que faltava — ignorar as
    // publicações abertas, soltar as reservas de slot e cancelar planos,
    // horizontes e chunks. `p_defer_batch_sync` fica falso porque um pedido de
    // exclusão toca pouquíssimos perfis: não há laço para amortizar.
    const { error: containError } = await admin.rpc('contain_instagram_profile_for_removal', {
      p_organization_id: profile.organization_id,
      p_profile_id: profile.id,
      p_incident_id: null,
      p_reason_code: 'profile_removed_by_data_deletion',
      p_reason_message: 'Exclusão de dados solicitada à Meta; publicação cancelada.',
      p_actor_label: 'system: meta-data-deletion',
      p_finalize_local: true,
      p_defer_batch_sync: false,
    });

    if (containError) {
      console.error('[meta-data-deletion] profile_delete_failed', {
        profileId: profile.id,
        message: containError.message,
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
