import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { getTwitterRequestContext } from '@/lib/twitter/request-context';

export async function DELETE(request: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  const auth = await getTwitterRequestContext('admin');
  if ('response' in auth) return auth.response;
  const { connectionId } = await params;
  const body = await request.json().catch(() => ({})) as { reason?: unknown };
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < 3) return NextResponse.json({ error: 'Informe o motivo da remoção.' }, { status: 400 });
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.rpc('twitter_soft_delete_connection', {
    p_organization_id: auth.context.activeOrganization.id,
    p_connection_id: connectionId,
    p_reason: reason,
    p_actor_user_id: auth.context.user.id,
    p_actor_email: auth.context.user.email ?? null,
  });
  if (error) return NextResponse.json({ error: 'Não foi possível remover a conexão do X.' }, { status: 400 });
  return NextResponse.json(data);
}
