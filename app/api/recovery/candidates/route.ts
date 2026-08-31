import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { RECOVERY_CANDIDATES_MAX, listRecoveryCandidates } from '@/lib/recovery/snapshot';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function noStoreJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set('Cache-Control', 'no-store, max-age=0');
  return NextResponse.json(body, { ...init, headers });
}

/**
 * Candidatos de uma execução.
 *
 * Devolve o **superconjunto de 40%** etiquetado por severidade, de propósito: o
 * botão 25%/40% é filtro de cliente, e é isso que permite girar o ajuste e
 * comparar os dois cenários sem requisição nova. Quando `hasMore` vem
 * verdadeiro a tela precisa recusar a ação em massa sobre "todos" e pedir para
 * refinar — agir sobre um conjunto diferente do que se mostrou é pior do que
 * pedir mais um clique.
 */
export async function GET(request: Request) {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) {
    return noStoreJson({ error: 'Autenticação necessária.' }, { status: 401 });
  }

  const url = new URL(request.url);
  const runId = url.searchParams.get('runId');
  const groupId = url.searchParams.get('groupId');

  if (!runId || !uuidPattern.test(runId)) {
    return noStoreJson({ error: 'Informe a execução a listar.' }, { status: 400 });
  }
  if (groupId && !uuidPattern.test(groupId)) {
    return noStoreJson({ error: 'Grupo inválido.' }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  try {
    const page = await listRecoveryCandidates(supabase, runId, groupId);
    return noStoreJson({ ...page, limit: RECOVERY_CANDIDATES_MAX });
  } catch (error) {
    return noStoreJson(
      { error: error instanceof Error ? error.message : 'Não foi possível carregar os candidatos.' },
      { status: 500 },
    );
  }
}
