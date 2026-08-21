import { NextResponse } from 'next/server';

import { syncZernioInstagramAccounts } from '@/lib/integrations/zernio-accounts';
import { getOrganizationContext } from '@/lib/organizations/server';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ connectionId: string }> },
) {
  const { connectionId } = await params;
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  if (!['admin', 'operator'].includes(context.activeOrganization.role)) return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });

  try {
    return NextResponse.json(await syncZernioInstagramAccounts(context.activeOrganization.id, context.user.id, connectionId));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Não foi possível sincronizar a conta Zernio.' }, { status: 500 });
  }
}
