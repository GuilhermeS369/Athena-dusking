import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

type ExportRow = {
  group_id: string;
  group_name: string;
  group_consumption_mode: 'single_use' | 'reusable';
  row_kind: 'current' | 'fallen';
  username: string;
  zernio_connection_label: string | null;
  profile_added_at: string;
  profile_status: 'no_data' | 'online' | 'offline' | 'reauthorization_required' | 'fallen';
  fallen_at: string | null;
  fall_reason: string | null;
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ groupId: string }> },
) {
  const { groupId } = await params;
  const context = await getOrganizationContext();

  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }

  const supabase = await createSupabaseServerClient();
  const { data: group, error: groupError } = await supabase
    .from('profile_groups')
    .select('id, name')
    .eq('id', groupId)
    .eq('organization_id', context.activeOrganization.id)
    .is('deleted_at', null)
    .maybeSingle();

  if (groupError) {
    return NextResponse.json({ error: 'Não foi possível validar o grupo.' }, { status: 500 });
  }
  if (!group) {
    return NextResponse.json({ error: 'Grupo não encontrado.' }, { status: 404 });
  }

  const { data, error } = await supabase
    .from('group_profile_export_rows')
    .select('group_id, group_name, group_consumption_mode, row_kind, username, zernio_connection_label, profile_added_at, profile_status, fallen_at, fall_reason')
    .eq('organization_id', context.activeOrganization.id)
    .eq('group_id', groupId)
    .order('row_kind', { ascending: true })
    .order('username', { ascending: true });

  if (error) {
    return NextResponse.json({ error: 'Não foi possível preparar a exportação do grupo.' }, { status: 500 });
  }

  return NextResponse.json({
    group: { id: group.id, name: group.name },
    rows: (data ?? []) as ExportRow[],
  });
}
