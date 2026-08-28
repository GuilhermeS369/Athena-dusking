import { NextResponse } from 'next/server';

import { connectionIntentCallbackHash } from '@/lib/twitter/connection-intents';
import { getTwitterRequestContext } from '@/lib/twitter/request-context';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export async function GET(request: Request) {
  const auth = await getTwitterRequestContext('admin');
  if ('response' in auth) return auth.response;
  const url = new URL(request.url);
  const intentId = url.searchParams.get('intent');
  const token = url.searchParams.get('token');
  if (!intentId || !token) return NextResponse.redirect(new URL('/x/perfis?connectError=callback_invalida', url.origin));
  const admin = createSupabaseAdminClient();
  if (url.searchParams.get('error')) {
    const { data: intent } = await admin.from('twitter_connection_intents').select('id,callback_token_hash').eq('id', intentId).eq('organization_id', auth.context.activeOrganization.id).maybeSingle();
    if (intent?.callback_token_hash === connectionIntentCallbackHash(token)) await admin.from('twitter_connection_intents').update({ status: 'failed', completed_at: new Date().toISOString(), encrypted_auth_url: null, error_code: 'oauth_cancelled', error_message: 'A autorização do X foi cancelada ou recusada.' }).eq('id', intentId).eq('organization_id', auth.context.activeOrganization.id).in('status', ['preparing','ready']);
    return NextResponse.redirect(new URL(`/x/zernio/concluindo?intent=${encodeURIComponent(intentId)}`, url.origin));
  }
  const profileId = url.searchParams.get('profileId');
  const accountId = url.searchParams.get('accountId');
  const username = url.searchParams.get('username');
  if (url.searchParams.get('connected') !== 'twitter' || !profileId || !accountId) return NextResponse.redirect(new URL('/x/perfis?connectError=callback_incompleta', url.origin));
  const { data: scopedIntent } = await admin.from('twitter_connection_intents').select('id').eq('id', intentId).eq('organization_id', auth.context.activeOrganization.id).maybeSingle();
  if (!scopedIntent) return NextResponse.redirect(new URL('/x/perfis?connectError=callback_divergente', url.origin));
  const { error } = await admin.rpc('twitter_record_connection_intent_callback', {
    p_intent_id: intentId, p_callback_token_hash: connectionIntentCallbackHash(token),
    p_zernio_profile_id: profileId, p_account_id: accountId, p_username: username,
  });
  return NextResponse.redirect(new URL(error ? '/x/perfis?connectError=callback_divergente' : `/x/zernio/concluindo?intent=${encodeURIComponent(intentId)}`, url.origin));
}
