import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

import { encryptToken } from '@/lib/security/token-crypto';
import { initializeProfileAnalyticsState } from '@/lib/integrations/zernio-analytics';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import {
  MetaAppUnavailableError,
  resolveMetaAppCredentials,
  type MetaAppCredentials,
} from '@/lib/integrations/meta-app-credentials';
import {
  legacyMetaAppCredentials,
  metaRedirectUri,
  META_OAUTH_SCOPES,
  META_GRAPH_API_VERSION,
  META_OAUTH_COOKIE,
  safeReturnTo,
  verifySignedState,
} from '@/lib/integrations/meta-oauth';

type MetaTokenResponse = {
  access_token?: string;
  user_id?: string | number;
  expires_in?: number;
  /** Lista concedida de fato, quando a Meta a devolve. */
  permissions?: string | string[];
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

function redirectWithSuccess(
  origin: string,
  returnTo: string,
  outcome: 'created' | 'updated' | 'takeover' | 'restored',
  groupAssignment?: { status: 'assigned' | 'failed'; groupName: string | null; error?: string },
) {
  const url = new URL(safeReturnTo(returnTo), origin);
  url.searchParams.set('connected', outcome);
  if (groupAssignment) {
    url.searchParams.set('groupAssignment', groupAssignment.status);
    if (groupAssignment.groupName) url.searchParams.set('groupName', groupAssignment.groupName);
    if (groupAssignment.error) url.searchParams.set('groupAssignmentError', groupAssignment.error);
  }
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

/**
 * Vincula o perfil recém-conectado ao grupo pedido na linha do Bulk Meta.
 *
 * A inserção é idempotente: repetir a mesma linha em outro aparelho não duplica
 * a associação nem derruba a conexão. O grupo é relido antes para garantir que
 * ele ainda existe e pertence à organização — o intervalo entre gerar a lista e
 * autorizar no celular pode ser de horas.
 */
async function assignProfileToGroup(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  input: { organizationId: string; groupId: string; profileId: string; addedBy: string },
): Promise<{ status: 'assigned' | 'failed'; groupName: string | null; error?: string }> {
  const { data: group } = await admin
    .from('profile_groups')
    .select('id, name')
    .eq('id', input.groupId)
    .eq('organization_id', input.organizationId)
    .is('deleted_at', null)
    .maybeSingle();

  if (!group) {
    return { status: 'failed', groupName: null, error: 'o grupo não existe mais.' };
  }

  const { error } = await admin
    .from('profile_group_members')
    .upsert({
      organization_id: input.organizationId,
      group_id: group.id,
      profile_id: input.profileId,
      added_by: input.addedBy,
    }, { onConflict: 'group_id,profile_id', ignoreDuplicates: true });

  if (error) return { status: 'failed', groupName: group.name, error: error.message };
  return { status: 'assigned', groupName: group.name };
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
      metaAppId: state.metaAppId,
      returnTo: state.returnTo,
    });

    // A troca do código exige a MESMA credencial que abriu a autorização. Como
    // o state é assinado, o app vem de lá e não de uma variável de ambiente.
    //
    // A vaga não é reconferida aqui de propósito: o /start já barrou o app
    // cheio, e recusar agora jogaria fora um token que o usuário já autorizou
    // no celular. Reconexão de perfil existente também não ocupa vaga nova.
    let metaApp: MetaAppCredentials | null = null;

    if (state.metaAppId) {
      try {
        metaApp = await resolveMetaAppCredentials(state.organizationId, state.metaAppId, {
          requireFreeSlot: false,
        });
      } catch (error) {
        if (error instanceof MetaAppUnavailableError) {
          return redirectWithError(url.origin, state.returnTo, error.code, error.message);
        }
        throw error;
      }
    }

    // Retaguarda para autorizações abertas antes do cadastro de apps existir.
    const legacy = metaApp ? null : legacyMetaAppCredentials();
    if (!metaApp && !legacy) {
      return redirectWithError(url.origin, state.returnTo, 'meta_app_required');
    }
    const clientId = metaApp?.clientId ?? legacy!.clientId;
    const clientSecret = metaApp?.clientSecret ?? legacy!.clientSecret;

    const tokenResponse = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
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
        client_secret: clientSecret,
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

    // O callback já validou a sessão, o state assinado e o vínculo do usuário
    // com a organização acima. A gravação usa o cliente privilegiado porque o
    // perfil contém encrypted_access_token e a tabela base não é legível
    // integralmente pelo papel authenticated.
    //
    // A resolução de QUAL perfil recebe esta conexão fica na RPC, e não aqui,
    // porque ela precisa ser atômica: encontrar o alvo e gravar num passo só,
    // com lock por (organização, @). Ver migration 373 para o raciocínio.
    const admin = createSupabaseAdminClient();
    const { data: connectRows, error: connectError } = await admin.rpc('connect_meta_instagram_profile', {
      p_organization_id: state.organizationId,
      p_instagram_user_id: instagramUserId,
      p_username: profile.username,
      p_display_name: profile.name ?? null,
      p_profile_picture_url: profile.profile_picture_url ?? null,
      p_account_type: profile.account_type ?? null,
      p_encrypted_access_token: encryptToken(accessToken),
      p_token_expires_at: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
      p_meta_app_id: metaApp?.id ?? null,
      p_created_by: state.userId,
    });

    if (connectError) {
      console.error('[meta-oauth] profile_save_failed', {
        requestId,
        code: connectError.code,
        message: connectError.message,
        organizationId: state.organizationId,
        instagramUserId,
        username: profile.username,
      });
      return redirectWithError(
        url.origin,
        state.returnTo,
        'profile_save_failed',
        connectError.code ?? 'database_error',
      );
    }

    // Religou: o perfil voltou a ter app, então o rastro de órfão sai. É
    // cosmético — a lista de órfãos exige `meta_app_id` nulo, então quem
    // reconectou já saiu dela —, mas um distintivo velho na tela confunde.
    const connectedProfileId = (connectRows ?? [])[0]?.profile_id ?? null;
    if (connectedProfileId) {
      const { error: clearError } = await admin.rpc('clear_profile_orphan_origin', {
        p_profile_id: connectedProfileId,
      });
      if (clearError) console.warn('[meta-oauth] clear_orphan_origin_failed', { requestId, message: clearError.message });
    }

    const connectResult = (connectRows ?? [])[0] as {
      profile_id: string | null;
      // `restored`: perfil excluído pelo operador reativado na mesma linha
      // (migration 440).
      outcome: 'created' | 'updated' | 'takeover' | 'restored' | 'conflict';
      previous_provider: string | null;
      previous_username: string | null;
    } | undefined;

    // Duas linhas diferentes reivindicam a mesma conta. Fundir envolve escolher
    // qual histórico sobrevive, então a conexão para aqui em vez de adivinhar.
    if (!connectResult || connectResult.outcome === 'conflict' || !connectResult.profile_id) {
      console.error('[meta-oauth] profile_identity_conflict', {
        requestId,
        organizationId: state.organizationId,
        instagramUserId,
        username: profile.username,
        previousProvider: connectResult?.previous_provider,
      });
      return redirectWithError(
        url.origin,
        state.returnTo,
        'meta_profile_conflict',
        JSON.stringify({ username: profile.username, previousUsername: connectResult?.previous_username }),
      );
    }

    const savedProfile = { id: connectResult.profile_id };

    // Registra o que a conta REALMENTE concedeu. A Meta nem sempre devolve a
    // lista; quando não devolve, o pedido é a melhor informação disponível — e
    // fica explícito na chave `granted` qual dos dois casos é este, para não
    // parecer que a permissão foi confirmada quando não foi.
    const grantedPermissions = (() => {
      const raw = longLived.permissions ?? shortLived.permissions;
      const list = Array.isArray(raw)
        ? raw
        : typeof raw === 'string' ? raw.split(',') : null;
      const scopes = list?.map((scope) => scope.trim()).filter(Boolean);
      return scopes?.length ? { scopes, granted: true } : { scopes: META_OAUTH_SCOPES, granted: false };
    })();

    await admin
      .from('instagram_profiles')
      .update({
        capabilities: Object.fromEntries([
          ...grantedPermissions.scopes.map((scope) => [scope, true]),
          ['permissions_confirmed_by_meta', grantedPermissions.granted],
        ]),
      })
      .eq('id', savedProfile.id)
      .eq('organization_id', state.organizationId);

    console.info('[meta-oauth] profile_connected', {
      requestId,
      profileId: connectResult.profile_id,
      outcome: connectResult.outcome,
      previousProvider: connectResult.previous_provider,
      username: profile.username,
    });

    if (savedProfile?.id) {
      await initializeProfileAnalyticsState(savedProfile.id).catch((error) => {
        console.error('[meta-oauth] profile_analytics_initialization_failed', {
          requestId,
          profileId: savedProfile.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    if (metaApp) {
      await admin.from('meta_apps')
        .update({ last_connected_at: new Date().toISOString() })
        .eq('id', metaApp.id)
        .eq('organization_id', state.organizationId);
    }

    // O grupo só entra depois que o perfil existe, e a falha aqui não desfaz a
    // conexão: perder o vínculo de grupo é reparável na tela de grupos, perder
    // a conta autorizada obrigaria a refazer o OAuth no celular.
    const groupAssignment = savedProfile?.id && state.groupId
      ? await assignProfileToGroup(admin, {
        organizationId: state.organizationId,
        groupId: state.groupId,
        profileId: savedProfile.id,
        addedBy: state.userId,
      }).catch((error) => ({
        status: 'failed' as const,
        groupName: null,
        error: safeErrorMessage(error),
      }))
      : undefined;

    if (groupAssignment?.status === 'failed') {
      console.error('[meta-oauth] group_assignment_failed', {
        requestId,
        profileId: savedProfile?.id,
        groupId: state.groupId,
        error: groupAssignment.error,
      });
    }

    const response = redirectWithSuccess(
      url.origin,
      state.returnTo,
      connectResult.outcome === 'takeover' ? 'takeover' : connectResult.outcome,
      groupAssignment,
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
