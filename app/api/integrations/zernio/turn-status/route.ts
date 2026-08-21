import { NextResponse } from 'next/server';

import { getZernioOauthTurnStatus } from '@/lib/integrations/zernio-oauth-turns';
import { getOrganizationContext } from '@/lib/organizations/server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  const turnId = new URL(request.url).searchParams.get('turnId')?.trim();
  if (!turnId) return NextResponse.json({ error: 'Turno inválido.' }, { status: 400 });
  try {
    return NextResponse.json(await getZernioOauthTurnStatus({
      organizationId: context.activeOrganization.id,
      turnId,
      createdBy: context.user.id,
    }));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Não foi possível consultar a fila.' }, { status: 404 });
  }
}

