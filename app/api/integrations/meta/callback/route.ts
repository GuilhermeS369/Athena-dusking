import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

import { encryptToken } from '@/lib/security/token-crypto';
import { initializeProfileAnalyticsState } from '@/lib/integrations/zernio-analytics';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import {
  metaClientId,
  metaClientSecret,
  metaRedirectUri,
  META_GRAPH_API_VERSION,
  META_OAUTH_COOKIE,
  safeReturnTo,
  verifySignedState,
} from '@/lib/integrations/meta-oauth';

type MetaTokenResponse = {
  access_token?: string;
  user_id?: string | number;
  expires_in?: number;
  error_type?: string;
  error_message?: string;
  error?: { message?: string; type?: string; code?: number; fbtrace_id?: string };
};

type MetaProfileResponse = {
  id?: string;
  user_id?: string;
  username?: string;
  name?: string;
  profile_picture_url?: string;
  account_type?: string;
  error?: { message?: string; type?: string; code?: number; fbtrace_id?: string };
};

function redirectWithError(
  origin: string,
  returnTo: string,
  error: string,
  diagnostic?: string,
) {
  const url = new URL(safeReturnTo(returnTo), origin);
  url.searchParams.set('error', error);
  if (diagnostic) url.searchParams.set('diagnostic', diagnostic.slice(0, 1800));
  return NextResponse.redirect(url);
}

function redirectWithSuccess(origin: string, returnTo: string, outcome: 'created' | 'updated') {
  const url = new URL(safeReturnTo(returnTo), origin);
  url.searchParams.set('connected', outcome);
  return NextResponse.redirect(url);
}

async function readJson<T>(response: Response) {
  return response.json() as Promise<T>;
}

function diagnosticPayload(
  stage: string,
  response: Response,
  payload: MetaTokenResponse | MetaProfileResponse,
  extra: Record<string, unknown> = {},
) {
  const error = payload.error;
  return JSON.stringify({
    stage,
    httpStatus: response.status,
    httpOk: response.ok,
    responseType: response.headers.get('content-type'),
    error: error
      ? { code: error.code, type: error.type, message: error.message, fbtrace_id: error.fbtrace_id }
      : {
          type: 'error_type' in payload ? payload.error_type : undefined,
          message: 'error_message' in payload ? payload.error_message : undefined,
        },
    ...extra,
  });
}

function requestDiagnostic(request: Request) {
  return request.headers.get('x-vercel-id') ?? 'local-no-vercel-request-id';
}

function safeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const returnTo = url.searchParams.get('returnTo');
  const code = url.searchParams.get('code');
  const stateValue = url.searchParams.get('state');
  const oauthCookie = (await cookies()).get(META_OAUTH_COOKIE)?.value;
  const requestId = requestDiagnostic(request);

  if (url.searchParams.get('error') || !code || !stateValue) {
    const diagnostic = JSON.stringify({
      stage: 'authorization_redirect',
      requestId,
      hasAuthorizationCode: Boolean(code),
      hasState: Boolean(stateValue),
      metaError: url.searchParams.get('error'),
      metaErrorReason: url.searchParams.get('error_reason'),
      metaErrorDescription: url.searchParams.get('error_description'),
      metaErrorCode: url.searchParams.get('error_code'),
    });
    console.error('[meta-oauth] authorization_redirect_failed', diagnostic);
    return redirectWithError(url.origin, returnTo ?? '/perfis', 'oauth_denied', diagnostic);
  }

  let state = null;

  try {
    state = verifySignedState(stateValue, oauthCookie);
  } catch {
    state = null;
  }

  if (!state) {
    return redirectWithError(url.origin, returnTo ?? '/perfis', 'invalid_state');
  }

  try {
    console.info('[meta-oauth] callback_started', {
      requestId,
      hasCode: Boolean(code),
      hasState: Boolean(stateValue),
      hasOauthCookie: Boolean(oauthCookie),
      returnTo: state.returnTo,
    });

    const tokenResponse = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: metaClientId(),
        client_secret: metaClientSecret(),
        grant_type: 'authorization_code',
        redirect_uri: metaRedirectUri(url.origin),
        code,
      }),
      cache: 'no-store',
    });
    const shortLived = await readJson<MetaTokenResponse>(tokenResponse);

    if (!tokenResponse.ok || !shortLived.access_token || !shortLived.user_id) {
      const diagnostic = diagnosticPayload('short_lived_token_exchange', tokenResponse, shortLived, {
        requestId,
        endpoint: 'https://api.instagram.com/oauth/access_token',
        hasAccessToken: Boolean(shortLived.access_token),
        hasUserId: Boolean(shortLived.user_id),
      });
      console.error('[meta-oauth] token_exchange_failed', diagnostic);
      return redirectWithError(url.origin, state.returnTo, 'token_exchange_failed', diagnostic);
    }

    const longLivedResponse = await fetch(
      `https://graph.instagram.com/${META_GRAPH_API_VERSION}/access_token?${new URLSearchParams({
        grant_type: 'ig_exchange_token',
        client_secret: metaClientSecret(),
        access_token: shortLived.access_token,
      })}`,
      { cache: 'no-store' },
    );
    const longLived = await readJson<MetaTokenResponse>(longLivedResponse);
    if (!longLivedResponse.ok || !longLived.access_token) {
      const diagnostic = diagnosticPayload('long_lived_token_exchange', longLivedResponse, longLived, {
        requestId,
        endpoint: `https://graph.instagram.com/${META_GRAPH_API_VERSION}/access_token`,
        fallbackToShortLivedToken: true,
      });
      console.warn('[meta-oauth] long_lived_token_exchange_failed', diagnostic);
    }
    const accessToken = longLived.access_token ?? shortLived.access_token;
    const expiresIn = longLived.expires_in ?? shortLived.expires_in;
    const profileResponse = await fetch(
      `https://graph.instagram.com/${META_GRAPH_API_VERSION}/me?${new URLSearchParams({
        fields: 'user_id,username,name,profile_picture_url,account_type',
        access_token: accessToken,
      })}`,
      { cache: 'no-store' },
    );
    const profile = await readJson<MetaProfileResponse>(profileResponse);
    const instagramUserId = String(profile.id ?? profile.user_id ?? shortLived.user_id);

    if (!profileResponse.ok || !profile.username || !instagramUserId) {
      const diagnostic = diagnosticPayload('profile_lookup', profileResponse, profile, {
        requestId,
        endpoint: `https://graph.instagram.com/${META_GRAPH_API_VERSION}/me`,
        lookupMode: 'token_subject_me',
        requestedFields: ['user_id', 'username', 'name', 'profile_picture_url', 'account_type'],
        tokenExchangeUserId: String(shortLived.user_id),
        resolvedInstagramUserId: instagramUserId || null,
        hasUsername: Boolean(profile.username),
        returnedFields: Object.keys(profile).sort(),
        accountType: profile.account_type ?? null,
      });
      console.error('[meta-oauth] profile_lookup_failed', diagnostic);
      return redirectWithError(url.origin, state.returnTo, 'profile_lookup_failed', diagnostic);
    }

    console.info('[meta-oauth] profile_lookup_succeeded', {
      requestId,
      instagramUserId,
      username: profile.username,
      accountType: profile.account_type ?? null,
      usedLongLivedToken: Boolean(longLived.access_token),
    });

    const supabase = await createSupabaseServerClient();
    const { data: currentUser } = await supabase.auth.getUser();

    if (currentUser.user?.id !== state.userId) {
      return redirectWithError(url.origin, state.returnTo, 'session_changed');
    }

    const { data: membership } = await supabase
      .from('organization_members')
      .select('organization_id')
      .eq('organization_id', state.organizationId)
      .eq('user_id', state.userId)
      .maybeSingle();

    if (!membership) {
      return redirectWithError(url.origin, state.returnTo, 'organization_forbidden');
    }

    const { data: existingProfile, error: existingProfileError } = await supabase
      .from('instagram_profiles_safe')
      .select('id, deleted_at')
      .eq('organization_id', state.organizationId)
      .eq('instagram_user_id', instagramUserId)
      .maybeSingle();

    if (existingProfileError) {
      const diagnostic = JSON.stringify({
        stage: 'existing_profile_database_lookup',
        requestId,
        code: existingProfileError.code,
        message: existingProfileError.message,
        details: existingProfileError.details,
        hint: existingProfileError.hint,
      });
      console.error('[meta-oauth] existing_profile_lookup_failed', diagnostic);
      return redirectWithError(url.origin, state.returnTo, 'profile_lookup_failed', diagnostic);
    }

    // O callback já validou a sessão, o state assinado e o vínculo do usuário
    // com a organização acima. A gravação usa o cliente privilegiado porque
    // o perfil contém encrypted_access_token e a tabela base não é legível
    // integralmente pelo papel authenticated.
    const admin = createSupabaseAdminClient();
    const { data: savedProfile, error: saveError } = await admin
      .from('instagram_profiles')
      .upsert({
        ...(existingProfile?.id ? { id: existingProfile.id } : {}),
        organization_id: state.organizationId,
        instagram_user_id: instagramUserId,
        username: profile.username.trim(),
        display_name: profile.name ?? null,
        profile_picture_url: profile.profile_picture_url ?? null,
        account_type: profile.account_type ?? null,
        capabilities: {
          instagram_business_basic: true,
          instagram_business_content_publish: true,
        },
        encrypted_access_token: encryptToken(accessToken),
        token_expires_at: expiresIn
          ? new Date(Date.now() + expiresIn * 1000).toISOString()
          : null,
        status: 'no_data',
        deleted_at: null,
        created_by: state.userId,
      }, {
        onConflict: 'organization_id,instagram_user_id',
      })
      .select('id')
      .maybeSingle();

    if (saveError) {
      const diagnostic = saveError.code ?? 'database_error';
      console.error('[meta-oauth] profile_save_failed', {
        requestId,
        code: saveError.code,
        message: saveError.message,
        details: saveError.details,
        hint: saveError.hint,
        organizationId: state.organizationId,
        instagramUserId,
      });
      return redirectWithError(url.origin, state.returnTo, 'profile_save_failed', diagnostic);
    }

    if (savedProfile?.id) {
      await initializeProfileAnalyticsState(savedProfile.id).catch((error) => {
        console.error('[meta-oauth] profile_analytics_initialization_failed', {
          requestId,
          profileId: savedProfile.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    const response = redirectWithSuccess(
      url.origin,
      state.returnTo,
      existingProfile?.id ? 'updated' : 'created',
    );
    response.cookies.set(META_OAUTH_COOKIE, '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 0,
    });
    return response;
  } catch (error) {
    console.error('[meta-oauth] oauth_callback_failed', {
      message: safeErrorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return redirectWithError(
      url.origin,
      state?.returnTo ?? returnTo ?? '/perfis',
      'oauth_callback_failed',
      JSON.stringify({ stage: 'unexpected_callback_exception', message: safeErrorMessage(error) }),
    );
  }
}
