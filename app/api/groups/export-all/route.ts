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

/**
 * Mesma projeção da exportação por grupo, sem o recorte de um grupo só: uma
 * planilha com todos os grupos da organização, nas mesmas colunas.
 */
export async function GET() {
  const context = await getOrganizationContext();

  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }

  // Fixado fora do callback: dentro da closure o TypeScript perde o estreitamento
  // de activeOrganization feito no guard acima.
  const organizationId = context.activeOrganization.id;
  const supabase = await createSupabaseServerClient();

  // Sem o .eq('group_id'), a organização inteira passa fácil do teto do
  // PostgREST — por isso pagina. group_name ordena para leitura e group_id
  // desempata homônimos, devolvendo a mesma garantia que o .eq() dava na rota
  // por grupo; do group_id para dentro a ordem é a de lá, com a mesma ressalva:
  // só empata se o mesmo perfil cair duas vezes no mesmo instante.
  const { data, error } = await fetchAllRows<ExportRow>((from, to) => supabase
    .from('group_profile_export_rows')
    .select('group_id, group_name, group_consumption_mode, row_kind, username, zernio_connection_label, profile_added_at, profile_status, fallen_at, fall_reason, profile_id, total_views, analytics_synced_at')
    .eq('organization_id', organizationId)
    .order('group_name', { ascending: true })
    .order('group_id', { ascending: true })
    .order('row_kind', { ascending: true })
    .order('username', { ascending: true })
    .order('profile_id', { ascending: true })
    .order('fallen_at', { ascending: true })
    .range(from, to));

  if (error) {
    return NextResponse.json({ error: 'Não foi possível preparar a exportação dos grupos.' }, { status: 500 });
  }

  return NextResponse.json({ rows: data });
}
