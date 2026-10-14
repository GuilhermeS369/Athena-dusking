import { NextResponse } from 'next/server';

import type { DashboardAccountFlow } from '@/lib/dashboard/v2-types';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * Contas plugadas e contas caídas por dia, com o motivo de cada queda.
 *
 * Organização inteira de propósito: a pergunta é "quanto entra e quanto cai por
 * dia", e ela não muda com o perfil ou o grupo escolhido nos filtros de cima —
 * uma conta caída já saiu do grupo. A agregação é toda no banco (migration
 * 449), e a resposta tem uma linha por dia, nunca uma por conta.
 */
export async function GET(request: Request) {
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

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('get_dashboard_account_flow', {
    p_organization_id: context.activeOrganization.id,
    p_start_date: startDate!,
    p_end_date: endDate!,
  });

  if (error || !data) {
    console.error('Dashboard plugadas x caídas indisponível.', {
      organizationId: context.activeOrganization.id,
      code: error?.code,
    });
    // O cartão é independente do resto da tela: se ele falhar, só ele avisa.
    return NextResponse.json({ error: 'Não foi possível carregar plugadas e quedas.' }, { status: 503 });
  }

  return NextResponse.json({ flow: data as DashboardAccountFlow }, {
    headers: { 'Cache-Control': 'private, no-store, max-age=0' },
  });
}
