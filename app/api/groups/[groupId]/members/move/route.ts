import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

type MoveMembersPayload = {
  targetGroupId?: unknown;
  profileIds?: unknown;
};

/**
 * Traduz o código do Postgres para algo acionável.
 *
 * O `23514` é o gatilho `enforce_group_membership_organization` (migration 002):
 * ele recusa vínculo para perfil apagado ou de outra organização. Desde a
 * migration 435 a RPC pula esses casos em vez de falhar, então ver este código
 * aqui significa que apareceu um caminho novo — e a mensagem precisa dizer isso
 * em vez de mandar a pessoa adivinhar.
 */
function describeMoveError(code: string | undefined) {
  if (code === '23514') return 'Algum perfil selecionado não existe mais ou é de outra organização';
  if (code === 'P0002') return 'Grupo de origem ou de destino não encontrado';
  if (code === '22023') return 'Grupos inválidos para esta movimentação';
  if (code === '42501') return 'Somente administradores e operadores podem mover perfis';
  return 'Não foi possível mover os perfis selecionados';
}

function parseProfileIds(value: unknown) {
  const values = Array.isArray(value) ? value : [];
  return [...new Set(values.map((item) => String(item ?? '').trim()).filter(Boolean))];
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ groupId: string }> },
) {
  const { groupId } = await params;
  const context = await getOrganizationContext();
  const organization = context.organizations.find((item) => item.id === context.activeOrganization?.id);

  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }

  if (!organization || !['admin', 'operator'].includes(organization.role)) {
    return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });
  }

  try {
    const body = await request.json() as MoveMembersPayload;
    const targetGroupId = String(body.targetGroupId ?? '').trim();
    const profileIds = parseProfileIds(body.profileIds);

    if (!targetGroupId) {
      return NextResponse.json({ error: 'Selecione o grupo de destino.' }, { status: 400 });
    }
    if (profileIds.length === 0) {
      return NextResponse.json({ error: 'Selecione ao menos um perfil válido.' }, { status: 400 });
    }

    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc('move_profile_group_members', {
      p_source_group_id: groupId,
      p_target_group_id: targetGroupId,
      p_profile_ids: profileIds,
    });

    if (error) {
      // O erro do banco precisa aparecer em algum lugar. Sem isto a falha chega
      // à tela como uma frase genérica e a causa se perde — foi exatamente o que
      // aconteceu em 18/09/2026, quando 10 vínculos podres no "xTESTE LEXY"
      // derrubaram a movimentação dos 66 e a tela não deu pista nenhuma.
      console.error('Falha ao mover perfis entre grupos.', {
        organizationId: context.activeOrganization.id,
        sourceGroupId: groupId,
        targetGroupId,
        profileCount: profileIds.length,
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      });
      return NextResponse.json({
        error: `${describeMoveError(error.code)} (código ${error.code ?? 'desconhecido'}).`,
        code: error.code ?? null,
      }, { status: 400 });
    }

    const result = data as { movedProfileIds?: string[]; skippedProfileIds?: string[] } | null;
    return NextResponse.json({
      ok: true,
      movedProfileIds: result?.movedProfileIds ?? [],
      skippedProfileIds: result?.skippedProfileIds ?? [],
    });
  } catch {
    return NextResponse.json({ error: 'Requisição inválida.' }, { status: 400 });
  }
}
