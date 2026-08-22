import { NextResponse } from 'next/server';

import { getTwitterRequestContext } from '@/lib/twitter/request-context';
import { syncTwitterProfiles } from '@/lib/twitter/zernio-profiles';

export async function POST(_request: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  const auth = await getTwitterRequestContext('operator');
  if ('response' in auth) return auth.response;
  const { connectionId } = await params;
  try {
    return NextResponse.json(await syncTwitterProfiles(auth.context.activeOrganization.id, connectionId));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Não foi possível sincronizar os perfis X.' }, { status: 400 });
  }
}
