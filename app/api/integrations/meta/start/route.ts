import { NextResponse } from 'next/server';

import {
  MetaAppUnavailableError,
  resolveMetaAppCredentials,
} from '@/lib/integrations/meta-app-credentials';
import {
  buildMetaAuthorizationUrl,
  createSignedState,
  metaRedirectUri,
  META_OAUTH_COOKIE,
  safeReturnTo,
} from '@/lib/integrations/meta-oauth';
import { buildMetaUnifiedLoginUrl } from '@/lib/integrations/meta-unified-login';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

function errorRedirect(origin: string, returnTo: string, error: string, diagnostic?: string) {
  const destination = new URL(safeReturnTo(returnTo), origin);
  destination.searchParams.set('error', error);
  if (diagnostic) destination.searchParams.set('diagnostic', diagnostic.slice(0, 500));
  return NextResponse.redirect(destination);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const context = await getOrganizationContext();

  if (!context.user || !context.activeOrganization) {
    return NextResponse.redirect(new URL('/login', url.origin));
  }

  const returnTo = safeReturnTo(url.searchParams.get('returnTo'));

  if (!['admin', 'operator'].includes(context.activeOrganization.role)) {
    return errorRedirect(url.origin, returnTo, 'forbidden');
  }

  const requestedGroupId = url.searchParams.get('groupId')?.trim() || null;
  // Reautorização de um perfil que já existe: o app certo é o que já detém a
  // conta, e não uma escolha nova. Ele também não consome vaga — o perfil já
  // ocupa a dele —, então um app cheio ainda consegue reautorizar os seus.
  const reauthorizeProfileId = url.searchParams.get('profileId')?.trim() || null;
  const organizationId = context.activeOrganization.id;

  let metaAppId = url.searchParams.get('appId')?.trim() || null;
  let requireFreeSlot = true;

  if (!metaAppId && reauthorizeProfileId) {
    const supabase = await createSupabaseServerClient();
    const { data: profile } = await supabase
      .from('instagram_profiles_safe')
      .select('meta_app_id')
      .eq('id', reauthorizeProfileId)
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .maybeSingle<{ meta_app_id: string | null }>();

    metaAppId = profile?.meta_app_id ?? null;
    requireFreeSlot = false;
  }

  // A credencial global deixou de abrir conexões novas. Sem app cadastrado o
  // fluxo para aqui, em vez de gastar uma autorização no Instagram e só depois
  // descobrir que a conta não tem onde ficar.
  if (!metaAppId) {
    return errorRedirect(url.origin, returnTo, 'meta_app_required');
  }

  try {
    const app = await resolveMetaAppCredentials(organizationId, metaAppId, { requireFreeSlot });

    if (requestedGroupId) {
      const supabase = await createSupabaseServerClient();
      const { data: group } = await supabase
        .from('profile_groups')
        .select('id')
        .eq('id', requestedGroupId)
        .eq('organization_id', organizationId)
        .is('deleted_at', null)
        .maybeSingle();

      if (!group) return errorRedirect(url.origin, returnTo, 'meta_group_not_found');
    }

    const { value, nonce } = createSignedState({
      organizationId,
      userId: context.user.id,
      returnTo,
      metaAppId: app.id,
      groupId: requestedGroupId,
    });
    const response = NextResponse.redirect(
      app.authMode === 'unified_login' && app.unifiedConfigId
        ? buildMetaUnifiedLoginUrl(value, metaRedirectUri(url.origin), app.clientId, app.unifiedConfigId)
        : buildMetaAuthorizationUrl(value, metaRedirectUri(url.origin), app.clientId),
    );

    response.cookies.set(META_OAUTH_COOKIE, nonce, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 10 * 60,
    });

    return response;
  } catch (error) {
    if (error instanceof MetaAppUnavailableError) {
      return errorRedirect(url.origin, returnTo, error.code, error.message);
    }

    console.error('[meta-oauth] start_failed', {
      organizationId,
      metaAppId,
      message: error instanceof Error ? error.message : String(error),
    });
    return errorRedirect(url.origin, returnTo, 'configuration');
  }
}
