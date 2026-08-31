import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const managerRoles = new Set(['admin', 'operator']);
const decisions = new Set(['recovered', 'partial', 'not_recovered', 'manual']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function noStoreJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set('Cache-Control', 'no-store, max-age=0');
  return NextResponse.json(body, { ...init, headers });
}

/**
 * Devolver perfis da esteira ao grupo de origem, registrando a decisão.
 *
 * A tela recomenda um veredito; quem decide é o operador — por isso a decisão
 * vem no corpo e não é derivada do índice. `targetGroupId` só é necessário
 * quando o grupo de origem foi apagado: a RPC recusa explicitamente em vez de
 * falhar de um jeito obscuro.
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

  let body: {
    cohortMemberIds?: unknown;
    decision?: unknown;
    note?: unknown;
    targetGroupId?: unknown;
  };
  try {
    body = await request.json() as typeof body;
  } catch {
    return noStoreJson({ error: 'Requisição inválida.' }, { status: 400 });
  }

  const cohortMemberIds = Array.isArray(body.cohortMemberIds)
    ? [...new Set(body.cohortMemberIds.filter(
        (value): value is string => typeof value === 'string' && uuidPattern.test(value),
      ))]
    : [];
  if (!cohortMemberIds.length) {
    return noStoreJson({ error: 'Selecione ao menos um perfil da esteira.' }, { status: 400 });
  }

  const decision = typeof body.decision === 'string' ? body.decision : 'manual';
  if (!decisions.has(decision)) {
    return noStoreJson({ error: 'Decisão inválida.' }, { status: 400 });
  }

  const targetGroupId = typeof body.targetGroupId === 'string' && uuidPattern.test(body.targetGroupId)
    ? body.targetGroupId
    : null;
  const note = typeof body.note === 'string' && body.note.trim().length
    ? body.note.trim().slice(0, 500)
    : null;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('return_from_recovery_cohort', {
    p_organization_id: context.activeOrganization.id,
    p_cohort_member_ids: cohortMemberIds,
    p_decision: decision,
    p_note: note,
    p_target_group_id: targetGroupId,
  });
  if (error) {
    return noStoreJson({ error: error.message }, { status: 400 });
  }
  return noStoreJson(data);
}
