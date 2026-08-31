import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function noStoreJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set('Cache-Control', 'no-store, max-age=0');
  return NextResponse.json(body, { ...init, headers });
}

/**
 * As duas linhas do gráfico de acompanhamento — mediana da coorte e mediana do
 * grupo de origem, nos mesmos dias — mais os marcos de troca de mídia.
 *
 * Sai das observações já gravadas pelo job diário: nenhuma agregação pesada no
 * caminho de renderização.
 */
export async function GET(request: Request) {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) {
    return noStoreJson({ error: 'Autenticação necessária.' }, { status: 401 });
  }

  const url = new URL(request.url);
  const recoveryGroupId = url.searchParams.get('recoveryGroupId');
  if (!recoveryGroupId || !uuidPattern.test(recoveryGroupId)) {
    return noStoreJson({ error: 'Informe a esteira.' }, { status: 400 });
  }
  const days = Number(url.searchParams.get('days') ?? 30);

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('get_recovery_cohort_series', {
    p_organization_id: context.activeOrganization.id,
    p_recovery_group_id: recoveryGroupId,
    p_days: Number.isFinite(days) ? Math.min(Math.max(Math.trunc(days), 1), 180) : 30,
  });
  if (error) return noStoreJson({ error: error.message }, { status: 500 });
  return noStoreJson(data ?? { points: [], milestones: [] });
}
