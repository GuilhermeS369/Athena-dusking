import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

function normalizeLabel(value: unknown) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function parseInstagramSlotLimit(value: unknown) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100) return null;
  return value;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ connectionId: string }> },
) {
  const { connectionId } = await params;
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  if (context.activeOrganization.role !== 'admin') return NextResponse.json({ error: 'Somente administradores podem editar contas Zernio.' }, { status: 403 });

  const body = await request.json().catch(() => ({})) as { label?: unknown; instagramSlotLimit?: unknown };
  const label = normalizeLabel(body.label);
  const instagramSlotLimit = body.instagramSlotLimit === undefined ? undefined : parseInstagramSlotLimit(body.instagramSlotLimit);
  if (body.label !== undefined && (label.length < 2 || label.length > 80)) return NextResponse.json({ error: 'Informe um nome entre 2 e 80 caracteres.' }, { status: 400 });
  if (body.instagramSlotLimit !== undefined && instagramSlotLimit === null) return NextResponse.json({ error: 'Informe um limite de Instagram entre 1 e 100 slots.' }, { status: 400 });
  if (body.label === undefined && body.instagramSlotLimit === undefined) return NextResponse.json({ error: 'Informe um nome ou limite de slots para atualizar.' }, { status: 400 });

  const admin = createSupabaseAdminClient();
  const { error } = await admin
    .from('zernio_connections')
    .update({
      ...(body.label === undefined ? {} : { label }),
      ...(instagramSlotLimit === undefined ? {} : { instagram_slot_limit: instagramSlotLimit }),
    })
    .eq('id', connectionId)
    .eq('organization_id', context.activeOrganization.id)
    .is('deleted_at', null);

  if (error) return NextResponse.json({ error: 'Não foi possível atualizar a conta Zernio.' }, { status: 400 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ connectionId: string }> },
) {
  const { connectionId } = await params;
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  if (context.activeOrganization.role !== 'admin') return NextResponse.json({ error: 'Somente administradores podem excluir contas Zernio.' }, { status: 403 });

  const body = await request.json().catch(() => ({})) as { confirmation?: unknown };
  if (body.confirmation !== 'EXCLUIR') return NextResponse.json({ error: 'Confirmação inválida. Digite EXCLUIR para remover a conta Zernio.' }, { status: 400 });

  const admin = createSupabaseAdminClient();
  const { count, error: countError } = await admin
    .from('instagram_profiles')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', context.activeOrganization.id)
    .eq('provider', 'zernio')
    .eq('zernio_connection_id', connectionId)
    .is('deleted_at', null);

  if (countError) return NextResponse.json({ error: 'Não foi possível validar os perfis vinculados.' }, { status: 500 });
  if ((count ?? 0) > 0) {
    return NextResponse.json({ error: 'Remova ou desconecte os perfis vinculados a esta conta antes de excluir a API key Zernio.' }, { status: 409 });
  }

  const { error } = await admin
    .from('zernio_connections')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', connectionId)
    .eq('organization_id', context.activeOrganization.id)
    .is('deleted_at', null);

  if (error) return NextResponse.json({ error: 'Não foi possível excluir a conta Zernio.' }, { status: 400 });
  return NextResponse.json({ ok: true });
}
