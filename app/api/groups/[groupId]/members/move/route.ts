import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

type MoveMembersPayload = {
  targetGroupId?: unknown;
  profileIds?: unknown;
};

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
      return NextResponse.json({ error: 'Não foi possível mover os perfis selecionados.' }, { status: 400 });
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
