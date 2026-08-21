import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, { params }: { params: Promise<{ planId: string }> }) {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }

  const { planId } = await params;
  if (!UUID_PATTERN.test(planId)) return NextResponse.json({ error: 'Plano inválido.' }, { status: 400 });

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('get_bulk_rotation_plan_progress', {
    p_organization_id: context.activeOrganization.id,
    p_plan_id: planId,
  });
  if (error) return NextResponse.json({ error: 'Não foi possível carregar o progresso do plano.' }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Plano não encontrado.' }, { status: 404 });

  return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
}
