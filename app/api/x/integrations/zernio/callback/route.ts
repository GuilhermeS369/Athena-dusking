import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { getTwitterRequestContext } from '@/lib/twitter/request-context';
import { syncTwitterProfiles } from '@/lib/twitter/zernio-profiles';

export async function GET(request: Request) {
  const auth = await getTwitterRequestContext('admin');
  if ('response' in auth) return auth.response;
  const url = new URL(request.url);
  const attemptId = url.searchParams.get('attempt');
  if (!attemptId) return NextResponse.redirect(new URL('/x/zernio?error=oauth_invalido', url.origin));
  const admin = createSupabaseAdminClient();
  const { data: attempt } = await admin.from('twitter_connection_oauth_attempts')
    .select('id, connection_id, created_by, status, expires_at')
    .eq('id', attemptId)
    .eq('organization_id', auth.context.activeOrganization.id)
    .maybeSingle();
  if (!attempt || attempt.created_by !== auth.context.user.id || attempt.status !== 'pending' || Date.parse(attempt.expires_at) <= Date.now()) {
    return NextResponse.redirect(new URL('/x/zernio?error=oauth_expirado', url.origin));
  }
  const providerError = url.searchParams.get('error');
  if (providerError) {
    await admin.from('twitter_connection_oauth_attempts').update({
      status: 'failed', error_code: providerError.slice(0, 120), error_message: 'A autorização do X não foi concluída.',
    }).eq('id', attempt.id);
    return NextResponse.redirect(new URL('/x/zernio?error=oauth_cancelado', url.origin));
  }
  try {
    const result = await syncTwitterProfiles(auth.context.activeOrganization.id, attempt.connection_id);
    await admin.from('twitter_connection_oauth_attempts').update({
      status: 'completed', completed_at: new Date().toISOString(), error_code: null, error_message: null,
    }).eq('id', attempt.id);
    await admin.from('twitter_connection_events').insert({
      organization_id: auth.context.activeOrganization.id,
      connection_id: attempt.connection_id,
      event_type: 'oauth_completed',
      actor_user_id: auth.context.user.id,
      actor_email: auth.context.user.email,
      message: 'Autorização X concluída e inventário sincronizado.',
      metadata: { attemptId, synced: result.synced },
    });
    return NextResponse.redirect(new URL(`/x/zernio?connected=${result.synced}`, url.origin));
  } catch {
    await admin.from('twitter_connection_oauth_attempts').update({
      status: 'failed', error_code: 'sync_failed', error_message: 'OAuth retornou, mas a sincronização falhou.',
    }).eq('id', attempt.id);
    return NextResponse.redirect(new URL('/x/zernio?error=sync_failed', url.origin));
  }
}
