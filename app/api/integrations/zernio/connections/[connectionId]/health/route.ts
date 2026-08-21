import { NextResponse } from 'next/server';

import { createZernioClientForConnection, refreshZernioConnectionBilling } from '@/lib/integrations/zernio-client';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ connectionId: string }> },
) {
  const { connectionId } = await params;
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  if (!['admin', 'operator'].includes(context.activeOrganization.role)) return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });

  const admin = createSupabaseAdminClient();
  const checkedAt = new Date().toISOString();

  try {
    const client = await createZernioClientForConnection(context.activeOrganization.id, connectionId);
    await client.listAccounts();
    const billing = await refreshZernioConnectionBilling(context.activeOrganization.id, connectionId).catch(() => null);
    const { error } = await admin
      .from('zernio_connections')
      .update({
        status: 'online',
        last_checked_at: checkedAt,
        last_success_at: checkedAt,
        last_error_code: null,
        last_error_message: null,
      })
      .eq('id', connectionId)
      .eq('organization_id', context.activeOrganization.id);

    if (error) return NextResponse.json({ error: 'Não foi possível salvar a checagem.' }, { status: 500 });
    return NextResponse.json({ status: 'online', checkedAt, billing });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Não foi possível validar a conta Zernio.';
    await admin
      .from('zernio_connections')
      .update({
        status: 'offline',
        last_checked_at: checkedAt,
        last_failure_at: checkedAt,
        last_error_code: 'zernio_health_failed',
        last_error_message: message.slice(0, 1200),
      })
      .eq('id', connectionId)
      .eq('organization_id', context.activeOrganization.id);

    return NextResponse.json({ error: message }, { status: 502 });
  }
}
