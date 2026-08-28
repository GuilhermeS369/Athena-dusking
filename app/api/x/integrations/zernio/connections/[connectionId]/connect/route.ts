import { NextResponse } from 'next/server';

import { enqueueTwitterConnectionIntent } from '@/lib/twitter/connection-intents';
import { getTwitterRequestContext } from '@/lib/twitter/request-context';

function cookieName(intentId: string) { return `twitter_intent_${intentId.replace(/-/g, '')}`; }

export async function POST(request: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  const auth = await getTwitterRequestContext('admin');
  if ('response' in auth) return auth.response;
  const { connectionId } = await params;
  try {
    const result = await enqueueTwitterConnectionIntent({
      organizationId: auth.context.activeOrganization.id,
      connectionId,
      groupId: null,
      actorUserId: auth.context.user.id,
      idempotencyKey: crypto.randomUUID(),
      origin: new URL(request.url).origin,
    });
    const waitingUrl = `/x/zernio/aguardando?intent=${encodeURIComponent(result.intentId)}`;
    const response = NextResponse.json({ intentId: result.intentId, state: result.status, expiresAt: result.expiresAt, authUrl: waitingUrl }, { status: 202 });
    response.cookies.set(cookieName(result.intentId), result.accessToken, {
      httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
      path: `/api/x/integrations/zernio/connect-intents/${result.intentId}`, maxAge: 20 * 60,
    });
    return response;
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Não foi possível iniciar o OAuth do X.' }, { status: 409 });
  }
}
