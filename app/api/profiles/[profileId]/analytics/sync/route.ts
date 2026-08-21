import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

type CreatedRefreshJob = { job_id: string; status: string; total_count: number; reused: boolean; reason: string };

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ profileId: string }> },
) {
  const { profileId } = await params;
  const context = await getOrganizationContext();
  const organization = context.organizations.find((item) => item.id === context.activeOrganization?.id);

  if (!context.user || !organization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }

  if (!['admin', 'operator'].includes(organization.role)) {
    return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });
  }

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc('create_profile_analytics_refresh_job', {
      p_organization_id: organization.id,
      p_trigger: 'manual',
      p_profile_ids: [profileId],
      p_stale_after_minutes: 5,
      p_manual_cooldown_seconds: 30,
      p_force: true,
    });

    if (error) throw error;
    const job = ((data ?? []) as CreatedRefreshJob[])[0] ?? null;
    return NextResponse.json({
      job,
      message: job?.reason === 'nothing_stale'
        ? 'Métricas dentro do cache; nenhuma chamada repetida foi feita.'
        : 'Atualização de métricas enfileirada em segundo plano.',
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Não foi possível agendar analytics.' }, { status: 500 });
  }
}
