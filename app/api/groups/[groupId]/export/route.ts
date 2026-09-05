import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { fetchAllRows } from '@/lib/supabase/paginate';
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
  profile_id: string;
  total_views: number | null;
  analytics_synced_at: string | null;
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

  // Fixado fora do callback: dentro da closure o TypeScript perde o estreitamento
  // de activeOrganization feito no guard acima.
  const organizationId = context.activeOrganization.id;
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

  // Grupos podem ter mais linhas que o teto do PostgREST. Sem paginar, a
  // planilha sai truncada sem aviso nenhum e o operador a usa como fonte de
  // verdade. Com o group_id fixado pelo .eq(), (row_kind, username, profile_id,
  // fallen_at) é ordem total: no ramo 'current' o perfil aparece uma vez só, e
  // no 'fallen' o counted_at separa quedas do mesmo perfil. Só empata se o
  // mesmo perfil cair duas vezes no mesmo instante.
  const { data, error } = await fetchAllRows<ExportRow>((from, to) => supabase
    .from('group_profile_export_rows')
    .select('group_id, group_name, group_consumption_mode, row_kind, username, zernio_connection_label, profile_added_at, profile_status, fallen_at, fall_reason, profile_id, total_views, analytics_synced_at')
    .eq('organization_id', organizationId)
    .eq('group_id', groupId)
    .order('row_kind', { ascending: true })
    .order('username', { ascending: true })
    .order('profile_id', { ascending: true })
    .order('fallen_at', { ascending: true })
    .range(from, to));

  if (error) {
    return NextResponse.json({ error: 'Não foi possível preparar a exportação do grupo.' }, { status: 500 });
  }

  return NextResponse.json({
    group: { id: group.id, name: group.name },
    rows: data,
  });
}
