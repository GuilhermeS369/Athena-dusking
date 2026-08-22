import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { getTwitterRequestContext } from '@/lib/twitter/request-context';

export async function PUT(request: Request, { params }: { params: Promise<{ groupId: string }> }) {
  const auth = await getTwitterRequestContext('operator');
  if ('response' in auth) return auth.response;
  const { groupId } = await params;
  const body = await request.json().catch(() => ({})) as { name?: unknown; description?: unknown; profileIds?: unknown };
  const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const profileIds = Array.isArray(body.profileIds) ? body.profileIds.filter((item): item is string => typeof item === 'string') : [];
  if (!name || name.length > 120 || description.length > 1000) return NextResponse.json({ error: 'Dados do grupo X inválidos.' }, { status: 400 });
  const admin = createSupabaseAdminClient();
  const { data: group, error } = await admin.from('twitter_groups').update({ name, description: description || null }).eq('id', groupId)
    .eq('organization_id', auth.context.activeOrganization.id).is('deleted_at', null).select('id').maybeSingle();
  if (error || !group) return NextResponse.json({ error: 'Grupo X não encontrado ou nome duplicado.' }, { status: error?.code === '23505' ? 409 : 404 });
  const { error: memberError } = await admin.rpc('twitter_replace_group_members', {
    p_organization_id: auth.context.activeOrganization.id, p_group_id: groupId, p_profile_ids: profileIds, p_actor_user_id: auth.context.user.id,
  });
  if (memberError) return NextResponse.json({ error: 'Não foi possível atualizar os membros X.' }, { status: 400 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ groupId: string }> }) {
  const auth = await getTwitterRequestContext('operator');
  if ('response' in auth) return auth.response;
  const { groupId } = await params;
  const admin = createSupabaseAdminClient();
  const { error } = await admin.from('twitter_groups').update({ deleted_at: new Date().toISOString() }).eq('id', groupId)
    .eq('organization_id', auth.context.activeOrganization.id).is('deleted_at', null);
  if (error) return NextResponse.json({ error: 'Não foi possível remover o grupo X.' }, { status: 500 });
  return NextResponse.json({ ok: true });
}
