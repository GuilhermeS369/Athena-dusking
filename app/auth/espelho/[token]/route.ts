import { NextResponse } from 'next/server';

import { hashAuthMirrorToken, isValidAuthMirrorToken } from '@/lib/auth/mirror-link';
import { ACTIVE_ORGANIZATION_COOKIE } from '@/lib/organizations/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ token: string }> };

type ActiveMirrorLink = {
  id: string;
  organization_id: string;
  created_by: string;
  created_by_email: string;
};

const MIRROR_LOGIN_LOCK_TTL_MS = 12_000;
const MIRROR_LOGIN_LOCK_WAIT_MS = 14_000;
const MIRROR_LOGIN_LOCK_POLL_MS = 220;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redirectToLogin(requestUrl: string, reason: 'invalid' | 'revoked' | 'error') {
  return NextResponse.redirect(new URL(`/login?mirror=${reason}`, requestUrl));
}

async function acquireMirrorLoginLock(admin: ReturnType<typeof createSupabaseAdminClient>, linkId: string, lockId: string) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < MIRROR_LOGIN_LOCK_WAIT_MS) {
    const lockUntil = new Date(Date.now() + MIRROR_LOGIN_LOCK_TTL_MS).toISOString();
    const { data, error } = await admin
      .from('auth_mirror_links')
      .update({ login_lock_id: lockId, login_lock_until: lockUntil })
      .eq('id', linkId)
      .eq('active', true)
      .or(`login_lock_until.is.null,login_lock_until.lt.${new Date().toISOString()}`)
      .select('id')
      .maybeSingle();

    if (error) throw error;
    if (data) return true;

    await sleep(MIRROR_LOGIN_LOCK_POLL_MS + Math.floor(Math.random() * 160));
  }

  return false;
}

async function releaseMirrorLoginLock(admin: ReturnType<typeof createSupabaseAdminClient>, linkId: string, lockId: string) {
  await admin
    .from('auth_mirror_links')
    .update({ login_lock_id: null, login_lock_until: null })
    .eq('id', linkId)
    .eq('login_lock_id', lockId);
}

export async function GET(request: Request, { params }: RouteContext) {
  const { token } = await params;

  if (!isValidAuthMirrorToken(token)) return redirectToLogin(request.url, 'invalid');

  const admin = createSupabaseAdminClient();
  const { data: link, error: linkError } = await admin
    .from('auth_mirror_links')
    .select('id, organization_id, created_by, created_by_email')
    .eq('token_hash', hashAuthMirrorToken(token))
    .eq('active', true)
    .maybeSingle<ActiveMirrorLink>();

  if (linkError) return redirectToLogin(request.url, 'error');
  if (!link) return redirectToLogin(request.url, 'revoked');

  const { data: membership, error: membershipError } = await admin
    .from('organization_members')
    .select('organization_id, user_id, organizations!inner(id, deleted_at)')
    .eq('organization_id', link.organization_id)
    .eq('user_id', link.created_by)
    .is('organizations.deleted_at', null)
    .maybeSingle();

  if (membershipError) return redirectToLogin(request.url, 'error');
  if (!membership) return redirectToLogin(request.url, 'revoked');

  const lockId = crypto.randomUUID();
  const locked = await acquireMirrorLoginLock(admin, link.id, lockId).catch(() => false);
  if (!locked) return redirectToLogin(request.url, 'error');

  try {
    const redirectTo = new URL('/perfis?mirror=ok', request.url).toString();
    const { data: generatedLink, error: generateError } = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email: link.created_by_email,
      options: { redirectTo },
    });

    const tokenHash = generatedLink?.properties?.hashed_token;
    if (generateError || !tokenHash) return redirectToLogin(request.url, 'error');

    const supabase = await createSupabaseServerClient();
    const { data: authData, error: verifyError } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: 'magiclink',
    });

    if (verifyError || authData.user?.id !== link.created_by) return redirectToLogin(request.url, 'error');

    await admin.rpc('record_auth_mirror_link_use', { p_link_id: link.id });
  } finally {
    await releaseMirrorLoginLock(admin, link.id, lockId);
  }

  const response = NextResponse.redirect(new URL('/perfis?mirror=ok', request.url));
  response.cookies.set(ACTIVE_ORGANIZATION_COOKIE, link.organization_id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });

  return response;
}
