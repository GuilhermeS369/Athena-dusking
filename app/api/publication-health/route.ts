import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

type PublicationHealthSummaryRow = {
  status: string;
  total: number;
  expired_leases: number;
  due_retries: number;
};

export async function GET() {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .rpc('get_publication_health_summary', {
      p_organization_id: context.activeOrganization.id,
    });

  if (error) return NextResponse.json({ error: 'Não foi possível consultar a fila.' }, { status: 500 });

  const rows = (data ?? []) as PublicationHealthSummaryRow[];
  const counts = rows.reduce<Record<string, number>>((result, item) => {
    result[item.status] = item.total;
    return result;
  }, {});

  return NextResponse.json({
    ok: true,
    queue: {
      counts,
      activeItems: rows.reduce((total, item) => total + item.total, 0),
      expiredLeases: rows.reduce((total, item) => total + item.expired_leases, 0),
      dueRetries: rows.reduce((total, item) => total + item.due_retries, 0),
    },
    checkedAt: new Date().toISOString(),
  });
}
