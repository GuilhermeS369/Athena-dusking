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
  const { data, error } = await supabase.rpc('get_publication_queue_reference_summary', {
    p_organization_id: context.activeOrganization.id,
  });

  if (error) {
    console.error('Não foi possível carregar resumo operacional da fila.', error);
    return NextResponse.json({ error: 'Não foi possível carregar o resumo da fila.' }, { status: 500 });
  }

  return NextResponse.json(data ?? { totals: {}, accounts: [], batches: [], groups: [] });
}
