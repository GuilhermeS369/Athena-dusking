import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

const MANAGER_ROLES = ['admin', 'operator'];

function isManager(role: string | undefined) {
  return Boolean(role && MANAGER_ROLES.includes(role));
}

function text(value: unknown, maxLength: number) {
  const result = String(value ?? '').trim();
  return result.length > maxLength ? result.slice(0, maxLength) : result;
}

export async function GET() {
  const context = await getOrganizationContext();

  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('profile_groups')
    .select('id, name, description, consumption_mode, default_caption, recovery_enabled, recovery_source_group_id, created_at, updated_at')
    .eq('organization_id', context.activeOrganization.id)
    .is('deleted_at', null)
    .order('updated_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: 'Não foi possível carregar os grupos.' }, { status: 500 });
  }

  return NextResponse.json({ groups: data ?? [] });
}

export async function POST(request: Request) {
  const context = await getOrganizationContext();
  const role = context.organizations.find(
    (organization) => organization.id === context.activeOrganization?.id,
  )?.role;

  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }

  if (!isManager(role)) {
    return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });
  }

  try {
    const body = await request.json() as {
      name?: unknown;
      description?: unknown;
      consumptionMode?: unknown;
      defaultCaption?: unknown;
    };
    const name = text(body.name, 120);
    const description = text(body.description, 500);
    const defaultCaption = text(body.defaultCaption, 2200);
    const consumptionMode = body.consumptionMode === 'reusable' ? 'reusable' : 'single_use';

    if (name.length < 2) {
      return NextResponse.json({ error: 'Informe um nome de grupo válido.' }, { status: 400 });
    }

    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from('profile_groups')
      .insert({
        organization_id: context.activeOrganization.id,
        name,
        description: description || null,
        consumption_mode: consumptionMode,
        default_caption: defaultCaption || null,
        created_by: context.user.id,
      })
      .select('id, name, description, consumption_mode, default_caption, recovery_enabled, recovery_source_group_id, created_at, updated_at')
      .single();

    if (error) {
      return NextResponse.json({ error: 'Não foi possível criar o grupo.' }, { status: 400 });
    }

    return NextResponse.json({ group: data }, { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Requisição inválida.' }, { status: 400 });
  }
}
