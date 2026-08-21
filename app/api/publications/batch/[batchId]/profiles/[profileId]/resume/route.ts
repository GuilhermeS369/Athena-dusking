import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

const MANAGER_ROLES = new Set(['admin', 'operator']);

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ batchId: string; profileId: string }> },
) {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }

  const role = context.organizations.find(
    (organization) => organization.id === context.activeOrganization?.id,
  )?.role;
  if (!role || !MANAGER_ROLES.has(role)) {
    return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });
  }

  const { batchId, profileId } = await params;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc(
    'resume_suspended_batch_profile_publications',
    {
      p_organization_id: context.activeOrganization.id,
      p_batch_id: batchId,
      p_profile_id: profileId,
      p_actor_label: context.user.email ?? null,
    },
  );

  if (error) {
    const status = error.code === 'P0002'
      ? 404
      : ['22023', '23505'].includes(error.code ?? '')
        ? 409
        : error.code === '42501'
          ? 403
          : 500;
    return NextResponse.json({
      error: status === 500
        ? 'Não foi possível retomar as publicações.'
        : error.message,
    }, { status });
  }

  return NextResponse.json({ resumption: data });
}
