import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

type AddMembersPayload = {
  profileId?: unknown;
  profileIds?: unknown;
};

function parseProfileIds(body: AddMembersPayload) {
  const values = Array.isArray(body.profileIds)
    ? body.profileIds
    : body.profileId === undefined
      ? []
      : [body.profileId];

  return [...new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean))];
}

async function resolveContext() {
  const context = await getOrganizationContext();
  const organization = context.organizations.find(
    (item) => item.id === context.activeOrganization?.id,
  );

  return { context, organization };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ groupId: string }> },
) {
  const { groupId } = await params;
  const { context } = await resolveContext();

  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('profile_group_members')
    .select('profile_id')
    .eq('group_id', groupId)
    .eq('organization_id', context.activeOrganization.id);

  if (error) {
    return NextResponse.json({ error: 'Não foi possível carregar os perfis do grupo.' }, { status: 500 });
  }

  return NextResponse.json({ profileIds: (data ?? []).map((item) => item.profile_id) });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ groupId: string }> },
) {
  const { groupId } = await params;
  const { context, organization } = await resolveContext();

  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }

  if (!organization || !['admin', 'operator'].includes(organization.role)) {
    return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });
  }

  const organizationId = context.activeOrganization.id;
  const userId = context.user.id;

  try {
    const body = await request.json() as AddMembersPayload;
    const profileIds = parseProfileIds(body);

    if (profileIds.length === 0) {
      return NextResponse.json({ error: 'Selecione ao menos um perfil válido.' }, { status: 400 });
    }

    const supabase = await createSupabaseServerClient();
    const { data: group, error: groupError } = await supabase
      .from('profile_groups')
      .select('id')
      .eq('id', groupId)
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .maybeSingle();

    if (groupError || !group) {
      return NextResponse.json({ error: 'Grupo não encontrado.' }, { status: 404 });
    }

    const { data: assignedProfiles, error: membershipLookupError } = await supabase
      .from('profile_group_members')
      .select('profile_id, group_id, profile_groups!inner(name)')
      .eq('organization_id', organizationId)
      .in('profile_id', profileIds)
      .neq('group_id', groupId);

    if (membershipLookupError) {
      return NextResponse.json({ error: 'Não foi possível validar os vínculos dos perfis.' }, { status: 500 });
    }

    if ((assignedProfiles ?? []).length > 0) {
      const firstConflict = assignedProfiles![0] as { profile_id: string; profile_groups: { name: string } | { name: string }[] | null };
      const conflictingGroup = Array.isArray(firstConflict.profile_groups)
        ? firstConflict.profile_groups[0]
        : firstConflict.profile_groups;
      return NextResponse.json({
        error: `Este perfil já pertence ao grupo “${conflictingGroup?.name ?? 'existente'}”. Remova-o de lá antes de adicioná-lo aqui.`,
        conflictProfileIds: assignedProfiles!.map((item) => item.profile_id),
      }, { status: 409 });
    }

    const { error } = await supabase.from('profile_group_members').upsert(
      profileIds.map((profileId) => ({
        organization_id: organizationId,
        group_id: groupId,
        profile_id: profileId,
        added_by: userId,
      })),
      { onConflict: 'group_id,profile_id' },
    );

    if (error) {
      return NextResponse.json({ error: 'Não foi possível adicionar o perfil ao grupo.' }, { status: 400 });
    }

    return NextResponse.json({ ok: true, profileIds }, { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Requisição inválida.' }, { status: 400 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ groupId: string }> },
) {
  const { groupId } = await params;
  const { context, organization } = await resolveContext();

  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }

  if (!organization || !['admin', 'operator'].includes(organization.role)) {
    return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });
  }

  try {
    const body = await request.json() as { profileId?: unknown };
    const profileId = String(body.profileId ?? '');
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase
      .from('profile_group_members')
      .delete()
      .eq('group_id', groupId)
      .eq('profile_id', profileId)
      .eq('organization_id', context.activeOrganization.id);

    if (error) {
      return NextResponse.json({ error: 'Não foi possível remover o perfil do grupo.' }, { status: 400 });
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Requisição inválida.' }, { status: 400 });
  }
}
