import { NextResponse } from 'next/server';

import type { DashboardV2Operations } from '@/lib/dashboard/v2-types';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * A metade operacional da dashboard: o que vem da fila de publicação.
 *
 * Vive numa rota separada da de métricas porque as duas têm custos muito
 * diferentes. Medido em 05/09/2026 na Pomodoro, período de 30 dias: a metade
 * de métrica agrega 12 mil linhas; esta varre 226 mil publicações. Juntas numa
 * resposta só, o gráfico de curtidas esperava a varredura da fila para
 * aparecer. Ver a migration 382.
 */

export async function GET(request: Request) {
  const startedAt = Date.now();
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  }

  const params = new URL(request.url).searchParams;
  const startDate = params.get('start');
  const endDate = params.get('end');
  const validDate = (value: string | null) => Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
  if (!validDate(startDate) || !validDate(endDate)) {
    return NextResponse.json({ error: 'Filtros inválidos.' }, { status: 400 });
  }

  const profileId = params.get('profileId');
  const groupId = params.get('groupId');
  const provider = params.get('provider');

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('get_dashboard_operations_v2', {
    p_organization_id: context.activeOrganization.id,
    p_start_date: startDate!,
    p_end_date: endDate!,
    p_profile_ids: profileId ? [profileId] : null,
    p_group_id: groupId || null,
    p_provider: provider || null,
    p_bucket: null,
  });

  if (error) {
    console.error('Dashboard V2 operações indisponível.', {
      organizationId: context.activeOrganization.id,
      code: error.code,
    });
    // Sem esta metade a tela continua útil: os gráficos de métrica não dependem
    // dela. Por isso 503 e não 500 — é indisponibilidade parcial, e o cliente
    // sabe seguir sem ela.
    return NextResponse.json({ error: 'Não foi possível carregar os números da fila.' }, { status: 503 });
  }

  console.info('Dashboard V2 operações carregada.', {
    organizationId: context.activeOrganization.id,
    startDate,
    endDate,
    durationMs: Date.now() - startedAt,
  });

  return NextResponse.json({ operations: data as DashboardV2Operations }, {
    headers: { 'Cache-Control': 'private, no-store, max-age=0' },
  });
}
