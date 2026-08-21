import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

function canManage(context: Awaited<ReturnType<typeof getOrganizationContext>>) {
  return Boolean(
    context.activeOrganization
      && context.organizations.some(
        (organization) => organization.id === context.activeOrganization?.id
          && ['admin', 'operator'].includes(organization.role),
      ),
  );
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ groupId: string }> },
) {
  const { groupId } = await params;
  const context = await getOrganizationContext();

  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }

  if (!canManage(context)) {
    return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });
  }

  try {
    const body = await request.json() as {
      name?: unknown;
      description?: unknown;
      consumptionMode?: unknown;
      defaultCaption?: unknown;
    };
    const name = String(body.name ?? '').trim();
    const description = String(body.description ?? '').trim();
    const defaultCaption = String(body.defaultCaption ?? '').trim();

    if (name.length < 2 || name.length > 120) {
      return NextResponse.json({ error: 'Informe um nome de grupo válido.' }, { status: 400 });
    }

    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from('profile_groups')
      .update({
        name,
        description: description || null,
        consumption_mode: body.consumptionMode === 'reusable' ? 'reusable' : 'single_use',
        default_caption: defaultCaption || null,
      })
      .eq('id', groupId)
      .eq('organization_id', context.activeOrganization.id)
      .is('deleted_at', null)
      .select('id, name, description, consumption_mode, default_caption, created_at, updated_at')
      .maybeSingle();

    if (error || !data) {
      return NextResponse.json({ error: 'Não foi possível atualizar o grupo.' }, { status: 400 });
    }

    return NextResponse.json({ group: data });
  } catch {
    return NextResponse.json({ error: 'Requisição inválida.' }, { status: 400 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ groupId: string }> },
) {
  const { groupId } = await params;
  const context = await getOrganizationContext();

  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }

  if (!canManage(context)) {
    return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from('profile_groups')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', groupId)
    .eq('organization_id', context.activeOrganization.id)
    .is('deleted_at', null);

  if (error) {
    return NextResponse.json({ error: 'Não foi possível excluir o grupo.' }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
