import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('get_paused_publication_batch_alerts', {
    p_organization_id: context.activeOrganization.id,
  });
  if (error) {
    console.error('Não foi possível consultar lotes pausados da fila.', error);
    return NextResponse.json({ error: 'Não foi possível consultar as pausas da fila.' }, { status: 500 });
  }

  return NextResponse.json(data ?? { snapshotAt: null, total: 0, blockedItems: 0, batches: [] });
}
