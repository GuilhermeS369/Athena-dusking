import { initializeProfileAnalyticsState } from '@/lib/integrations/zernio-analytics';
import {
  exchangeMetaUnifiedCode,
  fetchMetaUnifiedBusinessId,
  listMetaUnifiedAccounts,
  MetaUnifiedError,
  type MetaUnifiedAccount,
} from '@/lib/integrations/meta-unified-login';
import { encryptToken } from '@/lib/security/token-crypto';
import type { createSupabaseAdminClient } from '@/lib/supabase/admin';

type ConnectOutcome = 'created' | 'updated' | 'takeover' | 'restored';

type MetaGroupAssignment = { status: 'assigned' | 'failed'; groupName: string | null; error?: string };

export type MetaUnifiedConnectResult =
  | { ok: false; error: 'token_exchange_failed' | 'profile_lookup_failed'; diagnostic: string }
  | {
    ok: true;
    connected: { profileId: string; username: string; outcome: ConnectOutcome }[];
    failed: { username: string; reason: string }[];
    groupAssignment: MetaGroupAssignment | undefined;
  };

/**
 * Grava uma conta pela mesma RPC da rota antiga. O modo não é gravado no perfil:
 * ele vem do app em `p_meta_app_id`, e é assim que o publicador o descobre.
 */
async function saveAccount(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  input: {
    organizationId: string;
    userId: string;
    metaAppId: string;
    account: MetaUnifiedAccount;
    encryptedToken: string;
    tokenExpiresAt: string | null;
    clientBusinessId: string | null;
    requestId: string;
  },
) {
  const { account } = input;
  const { data: connectRows, error: connectError } = await admin.rpc('connect_meta_instagram_profile', {
    p_organization_id: input.organizationId,
    p_instagram_user_id: account.id,
    p_username: account.username,
    p_display_name: account.name,
    p_profile_picture_url: account.profilePictureUrl,
    // A documentação do host novo não lista `account_type`; pedir um campo
    // desconhecido daria erro 100 na conta inteira.
    p_account_type: null,
    p_encrypted_access_token: input.encryptedToken,
    p_token_expires_at: input.tokenExpiresAt,
    p_meta_app_id: input.metaAppId,
    p_created_by: input.userId,
  });

  if (connectError) {
    console.error('[meta-unified] profile_save_failed', {
      requestId: input.requestId,
      code: connectError.code,
      message: connectError.message,
      username: account.username,
    });
    return { ok: false as const, reason: connectError.code ?? 'database_error' };
  }

  const result = (connectRows ?? [])[0] as {
    profile_id: string | null;
    outcome: ConnectOutcome | 'conflict';
  } | undefined;

  if (!result?.profile_id || result.outcome === 'conflict') {
    return { ok: false as const, reason: 'meta_profile_conflict' };
  }

  const profileId = result.profile_id;

  const { error: clearError } = await admin.rpc('clear_profile_orphan_origin', { p_profile_id: profileId });
  if (clearError) console.warn('[meta-unified] clear_orphan_origin_failed', { requestId: input.requestId, message: clearError.message });

  // A Meta não devolve aqui o que foi concedido: as permissões estão na
  // configuração do painel. O id do portfólio fica guardado porque é ele que a
  // API de gestão de tokens pede, e não há outra chance de lê-lo sem token vivo.
  await admin
    .from('instagram_profiles')
    .update({
      capabilities: {
        auth_mode: 'unified_login',
        client_business_id: input.clientBusinessId,
        permissions_confirmed_by_meta: false,
      },
    })
    .eq('id', profileId)
    .eq('organization_id', input.organizationId);

  await initializeProfileAnalyticsState(profileId).catch((error) => {
    console.error('[meta-unified] profile_analytics_initialization_failed', {
      requestId: input.requestId,
      profileId,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  return { ok: true as const, profileId, outcome: result.outcome };
}

export async function connectMetaUnifiedAccounts(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  input: {
    organizationId: string;
    userId: string;
    metaAppId: string;
    groupId: string | null;
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    requestId: string;
    /** O vínculo de grupo da rota antiga, recebido para não existirem duas regras. */
    assignToGroup: (
      admin: ReturnType<typeof createSupabaseAdminClient>,
      input: { organizationId: string; groupId: string; profileId: string; addedBy: string },
    ) => Promise<MetaGroupAssignment>;
  },
): Promise<MetaUnifiedConnectResult> {
  let accessToken: string;
  let expiresIn: number | null;

  try {
    ({ accessToken, expiresIn } = await exchangeMetaUnifiedCode({
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      code: input.code,
      redirectUri: input.redirectUri,
    }));
  } catch (error) {
    const diagnostic = error instanceof MetaUnifiedError
      ? error.toDiagnostic({ requestId: input.requestId })
      : JSON.stringify({ stage: 'unified_token_exchange', requestId: input.requestId, message: String(error) });
    console.error('[meta-unified] token_exchange_failed', diagnostic);
    return { ok: false, error: 'token_exchange_failed', diagnostic };
  }

  let accounts: MetaUnifiedAccount[];
  try {
    accounts = await listMetaUnifiedAccounts(accessToken);
  } catch (error) {
    const diagnostic = error instanceof MetaUnifiedError
      ? error.toDiagnostic({ requestId: input.requestId })
      : JSON.stringify({ stage: 'unified_account_list', requestId: input.requestId, message: String(error) });
    console.error('[meta-unified] account_list_failed', diagnostic);
    return { ok: false, error: 'profile_lookup_failed', diagnostic };
  }

  if (accounts.length === 0) {
    const diagnostic = JSON.stringify({ stage: 'unified_no_assigned_accounts', requestId: input.requestId });
    console.error('[meta-unified] no_assigned_accounts', diagnostic);
    return { ok: false, error: 'profile_lookup_failed', diagnostic };
  }

  const clientBusinessId = await fetchMetaUnifiedBusinessId(accessToken);
  const encryptedToken = encryptToken(accessToken);
  const tokenExpiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

  const connected: { profileId: string; username: string; outcome: ConnectOutcome }[] = [];
  const failed: { username: string; reason: string }[] = [];
  let groupAssignment: MetaGroupAssignment | undefined;

  // Em série: cada conta trava (organização, @) na RPC, e a lista é pequena.
  for (const account of accounts) {
    const saved = await saveAccount(admin, {
      organizationId: input.organizationId,
      userId: input.userId,
      metaAppId: input.metaAppId,
      account,
      encryptedToken,
      tokenExpiresAt,
      clientBusinessId,
      requestId: input.requestId,
    });

    if (!saved.ok) {
      failed.push({ username: account.username, reason: saved.reason });
      continue;
    }

    connected.push({ profileId: saved.profileId, username: account.username, outcome: saved.outcome });

    if (input.groupId) {
      groupAssignment = await input.assignToGroup(admin, {
        organizationId: input.organizationId,
        groupId: input.groupId,
        profileId: saved.profileId,
        addedBy: input.userId,
      }).catch((error) => ({
        status: 'failed' as const,
        groupName: null,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  if (connected.length > 0) {
    await admin.from('meta_apps')
      .update({ last_connected_at: new Date().toISOString() })
      .eq('id', input.metaAppId)
      .eq('organization_id', input.organizationId);
  }

  console.info('[meta-unified] accounts_connected', {
    requestId: input.requestId,
    metaAppId: input.metaAppId,
    connected: connected.length,
    failed: failed.length,
  });

  return { ok: true, connected, failed, groupAssignment };
}
