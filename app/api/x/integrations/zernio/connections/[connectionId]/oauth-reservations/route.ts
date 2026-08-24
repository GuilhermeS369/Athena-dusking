import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { getTwitterRequestContext } from '@/lib/twitter/request-context';

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ connectionId: string }> },
) {
  const auth = await getTwitterRequestContext('admin');
  if ('response' in auth) return auth.response;
  const { connectionId } = await params;
  const admin = createSupabaseAdminClient();
  const { data: connection } = await admin.from('twitter_connections')
    .select('id').eq('id', connectionId)
    .eq('organization_id', auth.context.activeOrganization.id)
    .is('deleted_at', null).maybeSingle();
  if (!connection) return NextResponse.json({ error: 'Conexão X não encontrada.' }, { status: 404 });

  const { data, error } = await admin.from('twitter_connection_oauth_attempts').update({
    status: 'failed',
    error_code: 'oauth_cancelled_by_user',
    error_message: 'Reserva OAuth liberada manualmente no Athena.',
  }).eq('organization_id', auth.context.activeOrganization.id)
    .eq('connection_id', connectionId)
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .select('id');
  if (error) return NextResponse.json({ error: 'Não foi possível liberar a reserva OAuth.' }, { status: 409 });
  return NextResponse.json({ releasedReservations: data?.length ?? 0 });
}
