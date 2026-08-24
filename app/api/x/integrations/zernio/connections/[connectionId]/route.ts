import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { getTwitterRequestContext } from '@/lib/twitter/request-context';

export async function PATCH(request: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  const auth = await getTwitterRequestContext('admin');
  if ('response' in auth) return auth.response;
  const { connectionId } = await params;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  const limit = Number(body.twitterSlotLimit);
  if (label.length < 2 || label.length > 120 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    return NextResponse.json({ error: 'Informe um nome e limite de contas X válidos.' }, { status: 400 });
  }
  const admin = createSupabaseAdminClient();
  const { data: connection } = await admin.from('twitter_connections')
    .select('remote_twitter_account_count').eq('id', connectionId)
    .eq('organization_id', auth.context.activeOrganization.id).is('deleted_at', null).maybeSingle();
  if (!connection) return NextResponse.json({ error: 'Conexão não encontrada.' }, { status: 404 });
  const { count: localCount } = await admin.from('twitter_profile_connection_epochs').select('id', { count: 'exact', head: true })
    .eq('connection_id', connectionId).is('ended_at', null);
  const used = Math.max(Number(connection.remote_twitter_account_count ?? 0), localCount ?? 0);
  if (limit < used) return NextResponse.json({ error: `O limite não pode ser menor que as ${used} conta(s) X já vinculadas.` }, { status: 409 });
  const { data, error } = await admin.from('twitter_connections').update({ label, twitter_slot_limit: limit })
    .eq('id', connectionId).eq('organization_id', auth.context.activeOrganization.id)
    .is('deleted_at', null).select('id,label,twitter_slot_limit').single();
  if (error) return NextResponse.json({ error: error.code === '23505' ? 'Já existe uma conexão X com esse nome.' : 'Não foi possível salvar a configuração.' }, { status: 400 });
  return NextResponse.json({ connection: data });
}

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
  await admin.from('twitter_api_key_registry').update({
    status: 'retired', connection_id: null, import_item_id: null,
  }).eq('connection_id', connectionId).eq('organization_id', auth.context.activeOrganization.id);
  return NextResponse.json(data);
}
