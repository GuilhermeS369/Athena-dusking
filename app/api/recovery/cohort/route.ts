import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { RECOVERY_COHORT_MAX, getRecoveryCohortPage } from '@/lib/recovery/snapshot';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const managerRoles = new Set(['admin', 'operator']);
const cohortStatuses = new Set(['active', 'returned', 'removed', 'all']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Teto de perfis por operação. Mais alto que isto não é um erro de digitação, é
 * um sinal de que o filtro está errado — e mover centenas de perfis de uma vez
 * torna o experimento ilegível.
 */
const MAX_ENTER_PROFILES = 200;

function noStoreJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set('Cache-Control', 'no-store, max-age=0');
  return NextResponse.json(body, { ...init, headers });
}

export async function GET(request: Request) {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) {
    return noStoreJson({ error: 'Autenticação necessária.' }, { status: 401 });
  }

  const url = new URL(request.url);
  const recoveryGroupId = url.searchParams.get('recoveryGroupId');
  const status = url.searchParams.get('status') ?? 'active';

  if (recoveryGroupId && !uuidPattern.test(recoveryGroupId)) {
    return noStoreJson({ error: 'Grupo inválido.' }, { status: 400 });
  }
  if (!cohortStatuses.has(status)) {
    return noStoreJson({ error: 'Situação inválida.' }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  try {
    const page = await getRecoveryCohortPage(supabase, context.activeOrganization.id, {
      recoveryGroupId,
      status,
    });
    return noStoreJson({ ...page, limit: RECOVERY_COHORT_MAX });
  } catch (error) {
    return noStoreJson(
      { error: error instanceof Error ? error.message : 'Não foi possível carregar a esteira.' },
      { status: 500 },
    );
  }
}

/**
 * Mandar perfis para a esteira.
 *
 * Uma RPC só, porque as três escritas (achar/criar o grupo "<origem> rec",
 * mover os membros, gravar a coorte com o baseline congelado) precisam ser
 * atômicas — cada chamada PostgREST é a própria transação, e encadear três
 * deixaria estados meio-feitos possíveis.
 *
 * A resposta traz `skippedProfileIds`: se outro operador moveu o perfil entre a
 * tela listar e o clique, isso precisa aparecer, não virar um "sucesso" que
 * esconde o que não aconteceu.
 */
export async function POST(request: Request) {
  const context = await getOrganizationContext();
  const role = context.organizations.find(
    (organization) => organization.id === context.activeOrganization?.id,
  )?.role;
  if (!context.user || !context.activeOrganization) {
    return noStoreJson({ error: 'Autenticação necessária.' }, { status: 401 });
  }
  if (!role || !managerRoles.has(role)) {
    return noStoreJson({ error: 'Ação não permitida.' }, { status: 403 });
  }

  let body: { sourceGroupId?: unknown; profileIds?: unknown; runId?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return noStoreJson({ error: 'Requisição inválida.' }, { status: 400 });
  }

  const sourceGroupId = typeof body.sourceGroupId === 'string' ? body.sourceGroupId : '';
  if (!uuidPattern.test(sourceGroupId)) {
    return noStoreJson({ error: 'Informe o grupo de origem.' }, { status: 400 });
  }

  const profileIds = Array.isArray(body.profileIds)
    ? [...new Set(body.profileIds.filter(
        (value): value is string => typeof value === 'string' && uuidPattern.test(value),
      ))]
    : [];
  if (!profileIds.length) {
    return noStoreJson({ error: 'Selecione ao menos um perfil.' }, { status: 400 });
  }
  if (profileIds.length > MAX_ENTER_PROFILES) {
    return noStoreJson({
      error: `Mande no máximo ${MAX_ENTER_PROFILES} perfis por vez. Acima disso o experimento fica ilegível.`,
    }, { status: 400 });
  }

  const runId = typeof body.runId === 'string' && uuidPattern.test(body.runId) ? body.runId : null;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('enter_recovery_cohort', {
    p_organization_id: context.activeOrganization.id,
    p_source_group_id: sourceGroupId,
    p_profile_ids: profileIds,
    p_run_id: runId,
  });
  if (error) {
    return noStoreJson({ error: error.message }, { status: 400 });
  }
  return noStoreJson(data, { status: 200 });
}
