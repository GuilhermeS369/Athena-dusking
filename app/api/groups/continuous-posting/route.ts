import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { continuousPostingErrorResponse, isContinuousPostingAllowed } from '@/lib/publications/continuous-posting';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// Regras de postagem contínua da organização ativa (migration 443). Organização
// fora de CONTINUOUS_POSTING_ORG_IDS recebe 200 com `allowed: false`: é por essa
// resposta que a tela de Grupos esconde o recurso inteiro.

export async function GET() {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }

  const headers = { 'Cache-Control': 'no-store' };
  if (!isContinuousPostingAllowed(context.activeOrganization.id)) {
    return NextResponse.json({ allowed: false, rules: [] }, { headers });
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('get_continuous_posting_rules', { p_organization_id: context.activeOrganization.id });
  if (error) {
    const mapped = continuousPostingErrorResponse(error);
    if (mapped.status >= 500) console.error('Não foi possível consultar as regras de postagem contínua.', error);
    return NextResponse.json({ error: mapped.status >= 500 ? 'Não foi possível consultar a postagem contínua.' : mapped.message }, { status: mapped.status });
  }
  return NextResponse.json({ allowed: true, rules: Array.isArray(data) ? data : [] }, { headers });
}
