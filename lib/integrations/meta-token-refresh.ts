// Importes relativos com extensao, e nao o alias `@/`, porque este modulo e
// carregado pelos dois lados: as rotas do Next e o worker de renovacao, que roda
// direto no node e nao resolve o alias. Foi a falta disso que fez o worker
// nascer com uma copia da renovacao em vez de chamar esta funcao.
import { META_GRAPH_API_VERSION } from './meta-oauth.ts';
import { decryptToken, encryptToken } from '../security/token-crypto.ts';
import type { createSupabaseAdminClient } from '../supabase/admin.ts';

import {
  metaTokenRenewalState,
  type MetaTokenProfile,
} from './meta-token-renewal.ts';

/**
 * Renovação do token de longa duração da Meta.
 *
 * Detalhe que muda o alcance disto: `ig_refresh_token` usa **apenas o próprio
 * token**, não o App Secret. Então a renovação alcança também os perfis legados
 * conectados pela credencial global, que não têm app cadastrado. Eles não
 * precisam ser migrados para serem salvos do vencimento.
 *
 * Esta função é a unidade compartilhada: o botão manual da tela e o worker
 * diário chamam exatamente a mesma coisa, para não existirem duas noções de
 * "renovar" que divergem com o tempo.
 */

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

/** Tentativas de gravar o token novo antes de desistir. Ver o comentário no
 *  ponto da gravação: desistir aqui perde a credencial que a Meta já emitiu. */
const SAVE_ATTEMPTS = 4;

export type MetaTokenRefreshOutcome =
  | { status: 'refreshed'; profileId: string; username: string; expiresAt: string | null }
  | { status: 'skipped'; profileId: string; username: string; reason: 'too_young' | 'not_meta' | 'expired' | 'unified_login'; message: string }
  | { status: 'failed'; profileId: string; username: string; message: string; needsReauthorization: boolean };

type RefreshableProfile = MetaTokenProfile & {
  id: string;
  username: string;
  status: string;
  encrypted_access_token: string | null;
  meta_app_id: string | null;
};

const REFRESHABLE_COLUMNS =
  'id, username, status, provider, meta_app_id, encrypted_access_token, token_expires_at, token_refreshed_at, token_refresh_attempted_at, token_refresh_error, token_refresh_failure_count';

type RefreshResponse = {
  access_token?: string;
  expires_in?: number;
  error?: { code?: number; type?: string; message?: string };
};

function needsReauthorization(response: Response, payload: RefreshResponse) {
  return response.status === 401
    || response.status === 403
    || payload.error?.code === 190
    || payload.error?.type === 'OAuthException';
}

async function recordFailure(
  admin: AdminClient,
  profile: RefreshableProfile,
  message: string,
  reauthorization: boolean,
) {
  await admin
    .from('instagram_profiles')
    .update({
      token_refresh_attempted_at: new Date().toISOString(),
      token_refresh_error: message.slice(0, 500),
      token_refresh_failure_count: Math.max(0, profile.token_refresh_failure_count ?? 0) + 1,
      // Só o erro de autorização muda a situação do perfil. Um 500 da Meta é
      // ruído passageiro e não pode marcar a conta como quebrada na tela.
      ...(reauthorization ? { status: 'reauthorization_required' } : {}),
    })
    .eq('id', profile.id);
}

export async function refreshMetaProfileToken(
  admin: AdminClient,
  input: { organizationId: string; profileId: string; now?: number },
): Promise<MetaTokenRefreshOutcome> {
  const now = input.now ?? Date.now();
  const { data: profile } = await admin
    .from('instagram_profiles')
    .select(REFRESHABLE_COLUMNS)
    .eq('id', input.profileId)
    .eq('organization_id', input.organizationId)
    .is('deleted_at', null)
    .maybeSingle<RefreshableProfile>();

  if (!profile) {
    return {
      status: 'failed',
      profileId: input.profileId,
      username: '',
      message: 'Perfil não encontrado nesta organização.',
      needsReauthorization: false,
    };
  }

  const state = metaTokenRenewalState(profile, now);

  if (state.health === 'not_applicable') {
    return {
      status: 'skipped',
      profileId: profile.id,
      username: profile.username,
      reason: 'not_meta',
      message: 'Este perfil não usa a API oficial da Meta.',
    };
  }

  // Token de Unified Login não passa por `ig_refresh_token`. Tentar devolveria
  // erro de autorização, e `recordFailure` marcaria a conta para reautorizar,
  // suspendendo a fila dela. Falha nesta leitura segue o caminho de sempre.
  if (profile.meta_app_id) {
    const { data: app } = await admin
      .from('meta_apps')
      .select('auth_mode')
      .eq('id', profile.meta_app_id)
      .maybeSingle<{ auth_mode: string }>();

    if (app?.auth_mode === 'unified_login') {
      return {
        status: 'skipped',
        profileId: profile.id,
        username: profile.username,
        reason: 'unified_login',
        message: 'O token deste perfil é de Unified Login e não usa a renovação de 60 dias.',
      };
    }
  }

  // A Meta recusa renovar antes de 24 h. Chamar mesmo assim gastaria uma
  // requisição e ainda contaria uma falha contra um token perfeitamente bom.
  if (state.health !== 'unknown' && !state.canRefreshNow) {
    return state.health === 'expired'
      ? {
        status: 'skipped',
        profileId: profile.id,
        username: profile.username,
        reason: 'expired',
        message: 'O token passou de 60 dias sem renovar. A renovação não alcança mais: reconecte o perfil.',
      }
      : {
        status: 'skipped',
        profileId: profile.id,
        username: profile.username,
        reason: 'too_young',
        message: 'O token tem menos de 24 horas. A Meta só permite renovar depois disso.',
      };
  }

  if (!profile.encrypted_access_token) {
    await recordFailure(admin, profile, 'O perfil não tem token salvo para renovar.', true);
    return {
      status: 'failed',
      profileId: profile.id,
      username: profile.username,
      message: 'O perfil não tem token salvo para renovar. Reconecte a conta.',
      needsReauthorization: true,
    };
  }

  let currentToken: string;
  try {
    currentToken = decryptToken(profile.encrypted_access_token);
  } catch {
    await recordFailure(admin, profile, 'O token salvo não pôde ser decifrado.', true);
    return {
      status: 'failed',
      profileId: profile.id,
      username: profile.username,
      message: 'O token salvo não pôde ser decifrado. Reconecte a conta.',
      needsReauthorization: true,
    };
  }

  let response: Response;
  let payload: RefreshResponse;

  try {
    response = await fetch(
      `https://graph.instagram.com/${META_GRAPH_API_VERSION}/refresh_access_token?${new URLSearchParams({
        grant_type: 'ig_refresh_token',
        access_token: currentToken,
      })}`,
      { cache: 'no-store', signal: AbortSignal.timeout(20_000) },
    );
    payload = await response.json().catch(() => ({}) as RefreshResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordFailure(admin, profile, message, false);
    return {
      status: 'failed',
      profileId: profile.id,
      username: profile.username,
      message: `Não foi possível falar com a Meta: ${message}`,
      needsReauthorization: false,
    };
  }

  if (!response.ok || !payload.access_token) {
    const reauthorization = needsReauthorization(response, payload);
    const message = payload.error?.message?.trim()
      || `A Meta respondeu HTTP ${response.status} sem token novo.`;
    await recordFailure(admin, profile, message, reauthorization);
    return {
      status: 'failed',
      profileId: profile.id,
      username: profile.username,
      message,
      needsReauthorization: reauthorization,
    };
  }

  const expiresAt = payload.expires_in
    ? new Date(now + payload.expires_in * 1000).toISOString()
    : null;
  const refreshedAt = new Date().toISOString();

  const patch = {
    encrypted_access_token: encryptToken(payload.access_token),
    token_expires_at: expiresAt,
    token_refreshed_at: refreshedAt,
    token_refresh_attempted_at: refreshedAt,
    token_refresh_error: null,
    token_refresh_failure_count: 0,
    // A conta volta de 'reautorizar' sozinha: o token novo é a prova de que
    // a autorização segue válida. Qualquer outra situação é preservada,
    // porque uma queda de publicação não se resolve renovando token.
    ...(profile.status === 'reauthorization_required' ? { status: 'no_data' } : {}),
  };

  // A JANELA PERIGOSA está aqui: a Meta já emitiu o token novo e ele só existe
  // nesta variável. Se a gravação falhar, o token novo se perde — e não dá para
  // registrá-lo em log para recuperar depois, porque credencial não vai para
  // log. Por isso insiste antes de desistir: uma indisponibilidade momentânea
  // do PostgREST (aconteceu nesta operação em 02/09, com o pool esgotado) não
  // pode custar a credencial de um perfil. O token anterior continua valendo
  // até o prazo dele, então desistir adia, não quebra.
  let saveError: { message: string } | null = null;
  for (let attempt = 1; attempt <= SAVE_ATTEMPTS; attempt += 1) {
    const { error } = await admin.from('instagram_profiles').update(patch).eq('id', profile.id);
    if (!error) { saveError = null; break; }
    saveError = error;
    if (attempt < SAVE_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }

  if (saveError) {
    return {
      status: 'failed',
      profileId: profile.id,
      username: profile.username,
      message: `TOKEN NOVO PERDIDO — a Meta renovou, mas a gravação falhou ${SAVE_ATTEMPTS} vezes: ${saveError.message}. `
        + 'O perfil segue com o token anterior; a próxima renovação tenta de novo.',
      needsReauthorization: false,
    };
  }

  return { status: 'refreshed', profileId: profile.id, username: profile.username, expiresAt };
}

/**
 * Renova um lote, com concorrência limitada.
 *
 * O limite existe porque a renovação é uma chamada externa por perfil: sem
 * freio, um clique em uma organização grande abriria centenas de conexões de
 * uma vez contra a Meta e contra o pool do banco — o mesmo tipo de saturação
 * que derrubou a fila em 31/08.
 */
export async function refreshMetaProfileTokens(
  admin: AdminClient,
  input: { organizationId: string; profileIds: string[]; concurrency?: number; now?: number },
) {
  const concurrency = Math.max(1, Math.min(input.concurrency ?? 4, 8));
  const queue = [...input.profileIds];
  const outcomes: MetaTokenRefreshOutcome[] = [];

  async function drain() {
    for (let profileId = queue.shift(); profileId; profileId = queue.shift()) {
      outcomes.push(await refreshMetaProfileToken(admin, {
        organizationId: input.organizationId,
        profileId,
        now: input.now,
      }));
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, drain));

  return {
    outcomes,
    refreshed: outcomes.filter((outcome) => outcome.status === 'refreshed').length,
    skipped: outcomes.filter((outcome) => outcome.status === 'skipped').length,
    failed: outcomes.filter((outcome) => outcome.status === 'failed').length,
    needsReauthorization: outcomes.filter(
      (outcome) => outcome.status === 'failed' && outcome.needsReauthorization,
    ).length,
  };
}
