import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

const managerRoles = new Set(['admin', 'operator']);

export async function POST(_request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  const context = await getOrganizationContext();
  const { batchId } = await params;
  const role = context.organizations.find((organization) => organization.id === context.activeOrganization?.id)?.role;
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  if (!role || !managerRoles.has(role)) return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('resume_publication_batch_after_circuit_breaker', {
    p_organization_id: context.activeOrganization.id,
    p_batch_id: batchId,
    p_actor_label: context.user.email ?? null,
  });
  if (error) return NextResponse.json({ error: error.message || 'Não foi possível continuar o lote.' }, { status: 409 });
  return NextResponse.json({ continuation: data });
}
