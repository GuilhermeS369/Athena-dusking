import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

type RouteContext = { params: Promise<{ assetId: string }> };

export async function PUT(request: Request, routeContext: RouteContext) {
  const { assetId } = await routeContext.params;
  const context = await getOrganizationContext();
  const organization = context.organizations.find(
    (item) => item.id === context.activeOrganization?.id,
  );

  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }

  if (!organization || !['admin', 'operator'].includes(organization.role)) {
    return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });
  }

  let body: { groupIds?: unknown };
  try {
    body = await request.json() as { groupIds?: unknown };
  } catch {
    return NextResponse.json({ error: 'Corpo da requisição inválido.' }, { status: 400 });
  }

  if (!Array.isArray(body.groupIds) || body.groupIds.some((id) => typeof id !== 'string')) {
    return NextResponse.json({ error: 'Informe uma lista válida de grupos.' }, { status: 400 });
  }

  const groupIds = [...new Set(body.groupIds as string[])];
  const organizationId = context.activeOrganization.id;
  const userId = context.user.id;
  const supabase = await createSupabaseServerClient();
  const { data: asset } = await supabase
    .from('media_assets')
    .select('id')
    .eq('id', assetId)
    .eq('organization_id', organizationId)
    .is('deleted_at', null)
    .maybeSingle();

  if (!asset) {
    return NextResponse.json({ error: 'Mídia não encontrada.' }, { status: 404 });
  }

  if (groupIds.length > 0) {
    const { data: groups, error: groupsError } = await supabase
      .from('profile_groups')
      .select('id')
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .in('id', groupIds);

    if (groupsError || (groups ?? []).length !== groupIds.length) {
      return NextResponse.json({ error: 'Um ou mais grupos são inválidos.' }, { status: 400 });
    }
  }

  const { error: deleteError } = await supabase
    .from('media_group_assignments')
    .delete()
    .eq('organization_id', organizationId)
    .eq('media_asset_id', assetId);

  if (deleteError) {
    return NextResponse.json({ error: 'Não foi possível atualizar os grupos da mídia.' }, { status: 500 });
  }

  if (groupIds.length > 0) {
    const { error: insertError } = await supabase
      .from('media_group_assignments')
      .insert(groupIds.map((groupId) => ({
        organization_id: organizationId,
        media_asset_id: assetId,
        group_id: groupId,
        assigned_by: userId,
      })));

    if (insertError) {
      return NextResponse.json({ error: 'Não foi possível associar a mídia aos grupos.' }, { status: 500 });
    }
  }

  return NextResponse.json({ groupIds });
}
