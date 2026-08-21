import { NextResponse } from 'next/server';

import { syncZernioInstagramAccounts } from '@/lib/integrations/zernio-accounts';
import { getOrganizationContext } from '@/lib/organizations/server';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  if (!['admin', 'operator'].includes(context.activeOrganization.role)) return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });

  const body = await request.json().catch(() => ({})) as { connectionId?: unknown };
  const connectionId = typeof body.connectionId === 'string' ? body.connectionId.trim() : '';
  if (!connectionId) return NextResponse.json({ error: 'Selecione uma conta Zernio para sincronizar.' }, { status: 400 });

  try {
    return NextResponse.json(await syncZernioInstagramAccounts(context.activeOrganization.id, context.user.id, connectionId));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Não foi possível sincronizar contas Zernio.' }, { status: 500 });
  }
}
