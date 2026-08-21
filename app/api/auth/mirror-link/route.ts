import { NextResponse } from 'next/server';

import {
  authMirrorLinkStateFromRow,
  buildAuthMirrorUrl,
  generateAuthMirrorToken,
  hashAuthMirrorToken,
  type AuthMirrorLinkRow,
} from '@/lib/auth/mirror-link';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const managerRoles = new Set(['admin', 'operator']);

function canManageMirrorLink(role: string | undefined) {
  return Boolean(role && managerRoles.has(role));
}

async function requireMirrorLinkManager() {
  const context = await getOrganizationContext();

  if (!context.user || !context.activeOrganization) {
    return { context, response: NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 }) };
  }

  if (!canManageMirrorLink(context.activeOrganization.role)) {
    return { context, response: NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 }) };
  }

  return { context, response: null };
}

export async function GET() {
  const { context, response } = await requireMirrorLinkManager();
  if (response) return response;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('auth_mirror_links')
    .select('active, activated_at, created_by_email, last_used_at, use_count')
    .eq('organization_id', context.activeOrganization!.id)
    .eq('active', true)
    .maybeSingle<AuthMirrorLinkRow>();

  if (error) return NextResponse.json({ error: 'Não foi possível carregar o link espelho.' }, { status: 500 });

  return NextResponse.json({ mirrorLink: authMirrorLinkStateFromRow(data) });
}

export async function POST(request: Request) {
  const { context, response } = await requireMirrorLinkManager();
  if (response) return response;
  if (!context.user?.email) return NextResponse.json({ error: 'Seu usuário não possui e-mail confirmado para gerar o link.' }, { status: 400 });

  const admin = createSupabaseAdminClient();
  const token = generateAuthMirrorToken();
  const tokenHash = hashAuthMirrorToken(token);
  const now = new Date().toISOString();

  const { error: revokeError } = await admin
    .from('auth_mirror_links')
    .update({ active: false, revoked_at: now, revoked_by: context.user.id })
    .eq('organization_id', context.activeOrganization!.id)
    .eq('active', true);

  if (revokeError) return NextResponse.json({ error: 'Não foi possível rotacionar o link anterior.' }, { status: 500 });

  const { data, error } = await admin
    .from('auth_mirror_links')
    .insert({
      organization_id: context.activeOrganization!.id,
      created_by: context.user.id,
      created_by_email: context.user.email,
      token_hash: tokenHash,
      active: true,
      activated_at: now,
    })
    .select('active, activated_at, created_by_email, last_used_at, use_count')
    .single<AuthMirrorLinkRow>();

  if (error || !data) return NextResponse.json({ error: 'Não foi possível gerar o link espelho.' }, { status: 500 });

  return NextResponse.json({
    mirrorLink: authMirrorLinkStateFromRow(data),
    mirrorUrl: buildAuthMirrorUrl(request.url, token),
  });
}

export async function DELETE() {
  const { context, response } = await requireMirrorLinkManager();
  if (response) return response;

  const now = new Date().toISOString();
  const admin = createSupabaseAdminClient();
  const { error } = await admin
    .from('auth_mirror_links')
    .update({ active: false, revoked_at: now, revoked_by: context.user!.id })
    .eq('organization_id', context.activeOrganization!.id)
    .eq('active', true);

  if (error) return NextResponse.json({ error: 'Não foi possível desativar o link espelho.' }, { status: 500 });

  return NextResponse.json({ mirrorLink: authMirrorLinkStateFromRow(null) });
}
