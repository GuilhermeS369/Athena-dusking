import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export async function DELETE() {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  if (context.activeOrganization.role !== 'admin') return NextResponse.json({ error: 'Somente administradores podem limpar os logs.' }, { status: 403 });

  const admin = createSupabaseAdminClient();
  const { data: deletedCount, error } = await admin.rpc('clear_zernio_sync_conflict_logs', {
    p_organization_id: context.activeOrganization.id,
    p_requested_by: context.user.id,
  });
  if (error) return NextResponse.json({ error: 'Não foi possível limpar os conflitos de sincronização.' }, { status: 500 });

  return NextResponse.json({ ok: true, deletedCount: Number(deletedCount ?? 0) });
}
