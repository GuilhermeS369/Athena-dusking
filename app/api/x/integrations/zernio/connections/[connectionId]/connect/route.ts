import { NextResponse } from 'next/server';

import { getTwitterRequestContext } from '@/lib/twitter/request-context';
import { createTwitterOAuthAttempt } from '@/lib/twitter/zernio-connections';

export async function POST(request: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  const auth = await getTwitterRequestContext('admin');
  if ('response' in auth) return auth.response;
  const { connectionId } = await params;
  try {
    const result = await createTwitterOAuthAttempt({
      organizationId: auth.context.activeOrganization.id,
      connectionId,
      actorUserId: auth.context.user.id,
      origin: new URL(request.url).origin,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Não foi possível iniciar o OAuth do X.' }, { status: 400 });
  }
}
