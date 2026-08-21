import { NextResponse } from 'next/server';

import {
  buildMetaAuthorizationUrl,
  createSignedState,
  metaRedirectUri,
  META_OAUTH_COOKIE,
  safeReturnTo,
} from '@/lib/integrations/meta-oauth';
import { getOrganizationContext } from '@/lib/organizations/server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const context = await getOrganizationContext();

  if (!context.user || !context.activeOrganization) {
    return NextResponse.redirect(new URL('/login', url.origin));
  }

  if (!['admin', 'operator'].includes(context.activeOrganization.role)) {
    return NextResponse.redirect(new URL('/perfis?error=forbidden', url.origin));
  }

  try {
    const { value, nonce } = createSignedState({
      organizationId: context.activeOrganization.id,
      userId: context.user.id,
      returnTo: safeReturnTo(url.searchParams.get('returnTo')),
    });
    const response = NextResponse.redirect(
      buildMetaAuthorizationUrl(value, metaRedirectUri(url.origin)),
    );

    response.cookies.set(META_OAUTH_COOKIE, nonce, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 10 * 60,
    });

    return response;
  } catch {
    return NextResponse.redirect(new URL('/perfis?error=configuration', url.origin));
  }
}
