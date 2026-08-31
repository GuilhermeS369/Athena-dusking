import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { getRecoveryOverview } from '@/lib/recovery/snapshot';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

function noStoreJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set('Cache-Control', 'no-store, max-age=0');
  return NextResponse.json(body, { ...init, headers });
}

/**
 * Panorama da tela: a faixa da régua, os cards de grupo com sparkline e marcos,
 * e o estado da coleta. Tudo numa resposta só — a aba Elegíveis nunca toca
 * `profile_analytics_daily_metrics`, lê o snapshot da última execução.
 */
export async function GET(request: Request) {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) {
    return noStoreJson({ error: 'Autenticação necessária.' }, { status: 401 });
  }

  const runId = new URL(request.url).searchParams.get('runId');
  const supabase = await createSupabaseServerClient();

  try {
    const overview = await getRecoveryOverview(supabase, context.activeOrganization.id, runId);
    return noStoreJson(overview);
  } catch (error) {
    return noStoreJson(
      { error: error instanceof Error ? error.message : 'Não foi possível carregar a análise.' },
      { status: 500 },
    );
  }
}
