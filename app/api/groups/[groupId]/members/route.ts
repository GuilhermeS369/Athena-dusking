import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { fetchAllRowsByIds } from '@/lib/supabase/chunk';
import { fetchAllRows } from '@/lib/supabase/paginate';
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

  const organizationId = context.activeOrganization.id;
  const supabase = await createSupabaseServerClient();
  // Esta lista alimenta o "selecionar todos" do modal de grupos: truncada em
  // 1.000, a seleção em massa e a remoção operavam sobre um subconjunto do grupo.
  const { data, error } = await fetchAllRows((from, to) => supabase
    .from('profile_group_members')
    .select('profile_id')
    .eq('group_id', groupId)
    .eq('organization_id', organizationId)
    .order('profile_id', { ascending: true })
    .range(from, to));

  if (error) {
    return NextResponse.json({ error: 'Não foi possível carregar os perfis do grupo.' }, { status: 500 });
  }

  return NextResponse.json({ profileIds: data.map((item) => item.profile_id) });
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

    // Um perfil pode estar em vários outros grupos, então a leitura é 1:N sobre
    // uma lista de ids que pode passar de 1.000 numa adição em massa. A ordem por
    // (profile_id, group_id) é o que torna a paginação por bloco confiável.
    const { data: assignedProfiles, error: membershipLookupError } = await fetchAllRowsByIds<{ profile_id: string; group_id: string; profile_groups: { name: string } | { name: string }[] | null }>(
      profileIds,
      (chunk, from, to) => supabase
        .from('profile_group_members')
        .select('profile_id, group_id, profile_groups!inner(name)')
        .eq('organization_id', organizationId)
        .in('profile_id', chunk)
        .neq('group_id', groupId)
        .order('profile_id', { ascending: true })
        .order('group_id', { ascending: true })
        .range(from, to),
    );

    if (membershipLookupError) {
      return NextResponse.json({ error: 'Não foi possível validar os vínculos dos perfis.' }, { status: 500 });
    }

    if (assignedProfiles.length > 0) {
      const firstConflict = assignedProfiles[0];
      const conflictingGroup = Array.isArray(firstConflict.profile_groups)
        ? firstConflict.profile_groups[0]
        : firstConflict.profile_groups;
      return NextResponse.json({
        error: `Este perfil já pertence ao grupo “${conflictingGroup?.name ?? 'existente'}”. Remova-o de lá antes de adicioná-lo aqui.`,
        conflictProfileIds: assignedProfiles.map((item) => item.profile_id),
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
    const body = await request.json() as AddMembersPayload;
    const profileIds = parseProfileIds(body);

    if (profileIds.length === 0) {
      return NextResponse.json({ error: 'Selecione ao menos um perfil válido.' }, { status: 400 });
    }

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase
      .from('profile_group_members')
      .delete()
      .eq('group_id', groupId)
      .in('profile_id', profileIds)
      .eq('organization_id', context.activeOrganization.id);

    if (error) {
      return NextResponse.json({ error: 'Não foi possível remover o(s) perfil(is) do grupo.' }, { status: 400 });
    }

    return NextResponse.json({ ok: true, profileIds });
  } catch {
    return NextResponse.json({ error: 'Requisição inválida.' }, { status: 400 });
  }
}
