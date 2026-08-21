import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const allowedScopes = new Set(['attention_items', 'publication_events']);
const allowedActions = new Set(['clear', 'undo']);

export async function POST(request: Request) {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }

  let body: { scope?: unknown; action?: unknown };
  try {
    body = await request.json() as { scope?: unknown; action?: unknown };
  } catch {
    return NextResponse.json({ error: 'Requisição inválida.' }, { status: 400 });
  }

  if (typeof body.scope !== 'string' || typeof body.action !== 'string' || !allowedScopes.has(body.scope) || !allowedActions.has(body.action)) {
    return NextResponse.json({ error: 'Escopo ou ação inválidos.' }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('set_operational_log_visibility', {
    p_organization_id: context.activeOrganization.id,
    p_scope_key: body.scope,
    p_action: body.action,
  });
  if (error) {
    console.error('Não foi possível alterar a visibilidade operacional.', { organizationId: context.activeOrganization.id, scope: body.scope, error });
    return NextResponse.json({ error: 'Não foi possível alterar a visualização dos logs.' }, { status: error.code === '42501' ? 403 : 500 });
  }

  const actionRow = Array.isArray(data) ? data[0] : data;
  return NextResponse.json({ scope: body.scope, cleared: !actionRow?.undone_at, clearedAt: actionRow?.cleared_at ?? null });
}
