import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  }
  if (!['admin', 'operator'].includes(context.activeOrganization.role)) {
    return NextResponse.json({ error: 'Sem permissão para retomar a confirmação.' }, { status: 403 });
  }

  const payload = await request.json().catch(() => ({})) as { attemptId?: unknown };
  const attemptId = typeof payload.attemptId === 'string' ? payload.attemptId.trim() : '';
  if (!attemptId) return NextResponse.json({ error: 'Tentativa inválida.' }, { status: 400 });

  const { data: resumed, error } = await createSupabaseAdminClient().rpc(
    'resume_zernio_post_callback_recovery',
    {
      p_organization_id: context.activeOrganization.id,
      p_attempt_id: attemptId,
      p_created_by: context.user.id,
      p_recovery_seconds: 1500,
    },
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!resumed) {
    return NextResponse.json({ error: 'Esta confirmação não está disponível para retomada.' }, { status: 409 });
  }
  return NextResponse.json({ resumed: true });
}
