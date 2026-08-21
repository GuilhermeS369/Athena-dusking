import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.from('profile_groups').select('id, name').eq('organization_id', context.activeOrganization.id).is('deleted_at', null).order('name');
  if (error) return NextResponse.json({ error: 'Não foi possível carregar as origens.' }, { status: 500 });
  return NextResponse.json({ origins: [{ type: 'ungrouped', groupId: null, name: 'Sem grupo' }, ...(data ?? []).map((group) => ({ type: 'group', groupId: group.id, name: group.name }))] });
}
