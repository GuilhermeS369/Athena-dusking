import { NextResponse } from 'next/server';

import { refreshMetaProfileToken } from '@/lib/integrations/meta-token-refresh';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ profileId: string }> },
) {
  const { profileId } = await params;
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  if (!['admin', 'operator'].includes(context.activeOrganization.role)) {
    return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });
  }

  const outcome = await refreshMetaProfileToken(createSupabaseAdminClient(), {
    organizationId: context.activeOrganization.id,
    profileId,
  });

  if (outcome.status === 'failed') {
    return NextResponse.json(
      { error: outcome.message, needsReauthorization: outcome.needsReauthorization },
      // A falha é da Meta ou do token, não do pedido: 502 diz isso melhor que
      // 400 e evita que a tela trate um token revogado como erro de digitação.
      { status: outcome.needsReauthorization ? 409 : 502 },
    );
  }

  if (outcome.status === 'skipped') {
    return NextResponse.json({ ok: true, skipped: true, reason: outcome.reason, message: outcome.message });
  }

  return NextResponse.json({
    ok: true,
    refreshed: true,
    expiresAt: outcome.expiresAt,
    message: `Token de @${outcome.username} renovado por mais 60 dias.`,
  });
}
