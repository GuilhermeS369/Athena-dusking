import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { getTwitterRequestContext } from '@/lib/twitter/request-context';

export async function GET() {
  const auth = await getTwitterRequestContext();
  if ('response' in auth) return auth.response;
  const admin = createSupabaseAdminClient();
  const [groups, members] = await Promise.all([
    admin.from('twitter_groups').select('*').eq('organization_id', auth.context.activeOrganization.id).is('deleted_at', null).order('name'),
    admin.from('twitter_group_members').select('group_id,profile_id').eq('organization_id', auth.context.activeOrganization.id),
  ]);
  if (groups.error || members.error) return NextResponse.json({ error: 'Não foi possível carregar os grupos X.' }, { status: 500 });
  return NextResponse.json({ groups: groups.data ?? [], memberships: members.data ?? [] });
}

export async function POST(request: Request) {
  const auth = await getTwitterRequestContext('operator');
  if ('response' in auth) return auth.response;
  const body = await request.json().catch(() => ({})) as { name?: unknown; description?: unknown; profileIds?: unknown };
  const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const profileIds = Array.isArray(body.profileIds) ? body.profileIds.filter((item): item is string => typeof item === 'string') : [];
  if (name.length < 1 || name.length > 120 || description.length > 1000) return NextResponse.json({ error: 'Dados do grupo X inválidos.' }, { status: 400 });
  const admin = createSupabaseAdminClient();
  const groupId = randomUUID();
  const { error } = await admin.from('twitter_groups').insert({
    id: groupId, organization_id: auth.context.activeOrganization.id, name, description: description || null, created_by: auth.context.user.id,
  });
  if (error) return NextResponse.json({ error: error.code === '23505' ? 'Já existe um grupo X com esse nome.' : 'Não foi possível criar o grupo X.' }, { status: error.code === '23505' ? 409 : 500 });
  const { error: memberError } = await admin.rpc('twitter_replace_group_members', {
    p_organization_id: auth.context.activeOrganization.id, p_group_id: groupId,
    p_profile_ids: profileIds, p_actor_user_id: auth.context.user.id,
  });
  if (memberError) {
    await admin.from('twitter_groups').update({ deleted_at: new Date().toISOString() }).eq('id', groupId);
    return NextResponse.json({ error: 'Um ou mais perfis X são inválidos.' }, { status: 400 });
  }
  return NextResponse.json({ id: groupId }, { status: 201 });
}
