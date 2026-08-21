import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  if (!['admin', 'operator'].includes(context.activeOrganization.role)) return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('zernio_multi_connection_settings')
    .select('organization_id, default_instagram_slot_limit, updated_at')
    .eq('organization_id', context.activeOrganization.id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: 'Não foi possível carregar o limite padrão Zernio.' }, { status: 500 });
  return NextResponse.json({ settings: data ?? { organization_id: context.activeOrganization.id, default_instagram_slot_limit: 2 } });
}

export async function PATCH(request: Request) {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  if (context.activeOrganization.role !== 'admin') return NextResponse.json({ error: 'Somente administradores podem alterar o limite padrão.' }, { status: 403 });

  const body = await request.json().catch(() => ({})) as { defaultInstagramSlotLimit?: unknown };
  const defaultInstagramSlotLimit = Number(body.defaultInstagramSlotLimit);
  if (!Number.isInteger(defaultInstagramSlotLimit) || defaultInstagramSlotLimit < 1 || defaultInstagramSlotLimit > 100) {
    return NextResponse.json({ error: 'O limite padrão deve ser um inteiro entre 1 e 100.' }, { status: 400 });
  }

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.from('zernio_multi_connection_settings').upsert({
    organization_id: context.activeOrganization.id,
    default_instagram_slot_limit: defaultInstagramSlotLimit,
    updated_by: context.user.id,
  }, { onConflict: 'organization_id' }).select('default_instagram_slot_limit, updated_at').single();
  if (error) return NextResponse.json({ error: 'Não foi possível salvar o limite padrão.' }, { status: 500 });
  return NextResponse.json({ ok: true, settings: data });
}
