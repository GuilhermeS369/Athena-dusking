import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const managerRoles = new Set(['admin', 'operator']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function noStoreJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set('Cache-Control', 'no-store, max-age=0');
  return NextResponse.json(body, { ...init, headers });
}

/**
 * Registra no Histórico da Recuperação os perfis que o operador excluiu pela
 * tela — inclusive direto da aba Elegíveis, sem passar pela esteira.
 *
 * Fica numa rota própria, chamada logo após `/api/profiles/bulk-delete`
 * confirmar, em vez de dentro dela: a exclusão é um caminho compartilhado com
 * `/perfis` que já funciona, e pendurar registro de recuperação ali colocaria
 * funcionalidade nova no caminho crítico de outra. Falhar aqui não desfaz a
 * exclusão — é registro, não regra.
 *
 * Sem isto o Histórico contaria só os perfis que sobreviveram, perdendo
 * justamente os casos em que a recuperação falhou (ou nem foi tentada), que são
 * os que precisam ser lembrados na próxima rodada.
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

  let body: { profileIds?: unknown; runId?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return noStoreJson({ error: 'Requisição inválida.' }, { status: 400 });
  }

  const profileIds = Array.isArray(body.profileIds)
    ? [...new Set(body.profileIds.filter(
        (value): value is string => typeof value === 'string' && uuidPattern.test(value),
      ))]
    : [];
  if (!profileIds.length) {
    return noStoreJson({ recorded: 0 });
  }

  const runId = typeof body.runId === 'string' && uuidPattern.test(body.runId) ? body.runId : null;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('record_recovery_cohort_deletion', {
    p_organization_id: context.activeOrganization.id,
    p_profile_ids: profileIds,
    p_run_id: runId,
  });
  if (error) {
    // Registro falho não pode parecer exclusão falha: a exclusão já aconteceu.
    console.error('recovery_deletion_record_failed', {
      organizationId: context.activeOrganization.id,
      error: error.message,
    });
    return noStoreJson({ recorded: 0, warning: error.message }, { status: 200 });
  }
  return noStoreJson({ recorded: data ?? 0 });
}
