import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { provisionZernioConnection, ZernioDuplicateApiKeyError } from '@/lib/integrations/zernio-connection-provisioning';

export const dynamic = 'force-dynamic';

export async function GET() {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  if (!['admin', 'operator'].includes(context.activeOrganization.role)) return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('zernio_connections_safe')
    .select('*')
    .eq('organization_id', context.activeOrganization.id)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: 'Não foi possível carregar as contas Zernio.' }, { status: 500 });
  return NextResponse.json({ connections: data ?? [] });
}

export async function POST(request: Request) {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  if (context.activeOrganization.role !== 'admin') return NextResponse.json({ error: 'Somente administradores podem cadastrar contas Zernio.' }, { status: 403 });

  const body = await request.json().catch(() => ({})) as { label?: unknown; apiKey?: unknown };
  const label = typeof body.label === 'string' ? body.label.trim().replace(/\s+/g, ' ') : '';
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';

  if (label.length < 2 || label.length > 80) return NextResponse.json({ error: 'Informe um nome entre 2 e 80 caracteres para esta conta Zernio.' }, { status: 400 });
  if (!apiKey || apiKey.length < 12) return NextResponse.json({ error: 'Informe uma API key Zernio válida.' }, { status: 400 });

  try {
    const result = await provisionZernioConnection({
      organizationId: context.activeOrganization.id,
      organizationName: context.activeOrganization.name,
      createdBy: context.user.id,
      label,
      apiKey,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Não foi possível validar a conta Zernio.' },
      { status: error instanceof ZernioDuplicateApiKeyError ? 409 : 502 },
    );
  }
}
