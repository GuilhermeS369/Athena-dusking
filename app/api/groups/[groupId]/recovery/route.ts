import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const managerRoles = new Set(['admin', 'operator']);

/**
 * Liga e desliga a análise de recuperação de um grupo.
 *
 * Rota própria, e não um campo a mais no `PATCH /api/groups/[groupId]`: aquela
 * rota é de **substituição total** — exige `name` entre 2 e 120 e sobrescreve
 * `description`, `consumption_mode` e `default_caption` a cada chamada. Um
 * corpo parcial com só o toggle voltaria 400, e mandar o toggle junto de uma
 * renomeação faria o inverso: renomear o grupo desligaria a recuperação sem
 * ninguém pedir.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ groupId: string }> },
) {
  const { groupId } = await params;
  const context = await getOrganizationContext();
  const role = context.organizations.find(
    (organization) => organization.id === context.activeOrganization?.id,
  )?.role;

  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }
  if (!role || !managerRoles.has(role)) {
    return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });
  }

  let body: { recoveryEnabled?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: 'Requisição inválida.' }, { status: 400 });
  }
  if (typeof body.recoveryEnabled !== 'boolean') {
    return NextResponse.json({ error: 'Informe se a recuperação fica ligada.' }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();

  // Uma esteira não pode ser analisada como grupo de origem: ela é a coorte em
  // observação, não um conjunto de candidatos. Bloquear aqui evita um grupo
  // "rec" aparecendo na tela como se fosse um grupo comum.
  const { data: group, error: groupError } = await supabase
    .from('profile_groups')
    .select('id, recovery_source_group_id')
    .eq('id', groupId)
    .eq('organization_id', context.activeOrganization.id)
    .is('deleted_at', null)
    .maybeSingle();
  if (groupError || !group) {
    return NextResponse.json({ error: 'Grupo não encontrado.' }, { status: 404 });
  }
  if (group.recovery_source_group_id && body.recoveryEnabled) {
    return NextResponse.json(
      { error: 'Este grupo é uma esteira de recuperação; ele não é analisado como origem.' },
      { status: 400 },
    );
  }

  const { data, error } = await supabase
    .from('profile_groups')
    .update({ recovery_enabled: body.recoveryEnabled })
    .eq('id', groupId)
    .eq('organization_id', context.activeOrganization.id)
    .is('deleted_at', null)
    .select('id, name, recovery_enabled, recovery_source_group_id')
    .maybeSingle();

  if (error || !data) {
    return NextResponse.json({ error: 'Não foi possível atualizar o grupo.' }, { status: 400 });
  }
  return NextResponse.json({ group: data });
}
