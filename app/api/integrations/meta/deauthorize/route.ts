import { NextResponse } from 'next/server';

import { loadMetaAppSigners } from '@/lib/integrations/meta-app-signers';
import { parseMetaSignedRequest } from '@/lib/integrations/meta-webhook';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

/**
 * Callback de desautorização: a Meta chama esta URL quando a pessoa remove o
 * app em Configurações → Aplicativos e sites. O token daquela conta morre no
 * mesmo instante, então o perfil é marcado como `reauthorization_required` —
 * os dados **não** são apagados aqui, porque remover o app é desconectar, não
 * pedir exclusão. Para exclusão existe o callback próprio.
 *
 * O corpo vem como formulário, com um único campo `signed_request`.
 */
export async function POST(request: Request) {
  const body = new URLSearchParams(await request.text());
  const parsed = parseMetaSignedRequest(body.get('signed_request'), await loadMetaAppSigners());

  if (!parsed) {
    console.warn('[meta-deauthorize] invalid_signed_request');
    return NextResponse.json({ error: 'signed_request inválido.' }, { status: 401 });
  }

  const now = new Date().toISOString();
  const { data, error } = await createSupabaseAdminClient()
    .from('instagram_profiles')
    .update({
      status: 'reauthorization_required',
      last_error_code: 'app_deauthorized',
      last_error_message: 'O app foi removido nas configurações da conta.',
      last_failure_at: now,
      updated_at: now,
    })
    .eq('instagram_user_id', parsed.userId)
    .is('deleted_at', null)
    .select('id');

  if (error) {
    console.error('[meta-deauthorize] update_failed', {
      appId: parsed.signer.appId,
      message: error.message,
    });

    return NextResponse.json({ error: 'Falha ao registrar a desautorização.' }, { status: 500 });
  }

  console.info('[meta-deauthorize] applied', {
    appId: parsed.signer.appId,
    instagramUserId: parsed.userId,
    profiles: data?.length ?? 0,
  });

  return NextResponse.json({ ok: true });
}
