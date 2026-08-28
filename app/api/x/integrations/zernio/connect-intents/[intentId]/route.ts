import { NextResponse } from 'next/server';

import { connectionIntentTokenHash, decryptTwitterAuthUrl } from '@/lib/twitter/connection-intents';
import { getTwitterRequestContext } from '@/lib/twitter/request-context';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

function cookieName(intentId: string) { return `twitter_intent_${intentId.replace(/-/g, '')}`; }

export async function GET(request: Request, { params }: { params: Promise<{ intentId: string }> }) {
  const auth = await getTwitterRequestContext('admin');
  if ('response' in auth) return auth.response;
  const { intentId } = await params;
  const cookie = request.headers.get('cookie')?.split(';').map((value) => value.trim()).find((value) => value.startsWith(`${cookieName(intentId)}=`))?.split('=').slice(1).join('=');
  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  const accessToken = bearer || (cookie ? decodeURIComponent(cookie) : '');
  if (!accessToken) return NextResponse.json({ error: 'Token de acompanhamento ausente.' }, { status: 401 });
  const admin = createSupabaseAdminClient();
  const { data: intent } = await admin.from('twitter_connection_intents')
    .select('id,organization_id,connection_id,status,access_token_hash,encrypted_auth_url,auth_url_delivered_at,expires_at,error_code,error_message,returned_username,profile_id,created_at')
    .eq('id', intentId).eq('organization_id', auth.context.activeOrganization.id).maybeSingle();
  if (!intent || intent.access_token_hash !== connectionIntentTokenHash(accessToken)) return NextResponse.json({ error: 'Solicitação X não encontrada.' }, { status: 404 });
  const { count } = await admin.from('twitter_connection_intents').select('id', { count: 'exact', head: true })
    .eq('organization_id', intent.organization_id).in('status', ['queued','preparing']).lt('created_at', intent.created_at);
  let authUrl: string | null = null;
  if (intent.status === 'ready' && intent.encrypted_auth_url) {
    authUrl = decryptTwitterAuthUrl(intent.encrypted_auth_url);
    if (!intent.auth_url_delivered_at) await admin.from('twitter_connection_intents').update({ auth_url_delivered_at: new Date().toISOString() }).eq('id', intent.id).is('auth_url_delivered_at', null);
  }
  return NextResponse.json({
    intentId: intent.id, status: intent.status, queuePosition: intent.status === 'queued' ? Number(count ?? 0) + 1 : null,
    expiresAt: intent.expires_at, authUrl, username: intent.returned_username,
    errorCode: intent.error_code, errorMessage: intent.error_message, profileId: intent.profile_id,
  });
}
