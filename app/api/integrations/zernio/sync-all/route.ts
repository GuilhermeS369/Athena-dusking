import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';

import { enqueueZernioOrganizationSync } from '@/lib/integrations/zernio-accounts';
import { getOrganizationContext } from '@/lib/organizations/server';

export const dynamic = 'force-dynamic';

export async function POST() {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  if (context.activeOrganization.role !== 'admin') return NextResponse.json({ error: 'Apenas administradores podem iniciar a sincronia geral.' }, { status: 403 });
  const correlationId = randomUUID();
  try {
    const result = await enqueueZernioOrganizationSync(context.activeOrganization.id, context.user.id, correlationId);
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    const typed = error as { code?: string; message?: string } | undefined;
    console.error('[zernio-sync-enqueue-failed]', {
      correlationId,
      organizationId: context.activeOrganization.id,
      code: typed?.code ?? 'unknown',
      message: typed?.message ?? 'unknown_error',
    });
    return NextResponse.json({
      error: 'Não foi possível enfileirar a sincronia Zernio.',
      correlationId,
      code: typed?.code ?? 'zernio_sync_enqueue_failed',
    }, { status: 500 });
  }
}
