import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const META_OAUTH_COOKIE = 'athena-meta-oauth';
export const META_GRAPH_API_VERSION = process.env.META_GRAPH_API_VERSION ?? 'v26.0';
/**
 * Permissões pedidas na autorização.
 *
 * O QUE ESTÁ EM JOGO NA ORDEM DAS COISAS: a permissão é concedida no momento em
 * que a pessoa aceita, e vale para aquele token. Acrescentar uma permissão
 * depois NÃO alcança quem já conectou — exige refazer o OAuth conta por conta.
 * Numa frota de 1.551 perfis, descobrir a permissão faltando depois da migração
 * significa fazer a migração duas vezes.
 *
 * `manage_insights` é a que destrava a dashboard: sem ela o token lê o perfil e
 * publica, mas não enxerga visualizações, alcance nem impressões.
 *
 * A lista aceita ajuste por ambiente para o caso de a Meta recusar alguma
 * permissão no meio de uma migração em andamento — sem isso, destravar
 * dependeria de um deploy novo com a operação parada.
 *
 * `manage_comments` e `manage_messages` saíram na preparação da análise do app
 * (04/09/2026): a Meta exige gravação de tela demonstrando cada permissão, e
 * nenhuma tela do painel lê comentários ou Direct — permissão pedida sem uso
 * demonstrado é motivo comum de recusa. Devolver as duas é uma linha aqui, mas
 * o custo real é o do parágrafo acima: quem já conectou não passa a tê-las, e
 * a frota inteira precisaria refazer o OAuth. Se a caixa de comentários ou o
 * Direct entrarem no roadmap, decida ANTES da próxima migração em massa.
 */
export const META_OAUTH_SCOPES = (process.env.META_OAUTH_SCOPES ?? [
  'instagram_business_basic',
  'instagram_business_content_publish',
  'instagram_business_manage_insights',
].join(','))
  .split(',')
  .map((scope) => scope.trim())
  .filter(Boolean);

type OAuthState = {
  organizationId: string;
  userId: string;
  nonce: string;
  returnTo: string;
  expiresAt: number;
  /**
   * App da Meta escolhido para esta conexão. Nulo só em estados emitidos antes
   * do cadastro de apps existir — o /start atual sempre exige um app.
   */
  metaAppId: string | null;
  /** Grupo a vincular depois que o perfil existir. */
  groupId: string | null;
};

function requiredMetaEnv(name: 'META_OAUTH_STATE_SECRET') {
  const value = process.env[name];

  if (!value) {
    throw new Error(`A variável ${name} não está configurada.`);
  }

  return value;
}

export function metaRedirectUri(origin: string) {
  return process.env.REDIRECT_URI
    ?? process.env.META_OAUTH_REDIRECT_URI
    ?? new URL('/api/integrations/meta/callback', origin).toString();
}

function encodeState(state: OAuthState) {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
}

function sign(value: string) {
  return createHmac('sha256', requiredMetaEnv('META_OAUTH_STATE_SECRET'))
    .update(value)
    .digest('base64url');
}

export function createSignedState(
  input: Omit<OAuthState, 'nonce' | 'expiresAt' | 'metaAppId' | 'groupId'>
    & Partial<Pick<OAuthState, 'metaAppId' | 'groupId'>>,
) {
  const state: OAuthState = {
    metaAppId: null,
    groupId: null,
    ...input,
    nonce: randomBytes(32).toString('base64url'),
    expiresAt: Date.now() + 10 * 60 * 1000,
  };
  const payload = encodeState(state);

  return {
    value: `${payload}.${sign(payload)}`,
    nonce: state.nonce,
  };
}

export function verifySignedState(value: string, expectedNonce: string | undefined) {
  const [payload, signature] = value.split('.');

  if (!payload || !signature || !expectedNonce) {
    return null;
  }

  const expectedSignature = sign(payload);
  const received = Buffer.from(signature, 'base64url');
  const expected = Buffer.from(expectedSignature, 'base64url');

  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return null;
  }

  try {
    const state = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as OAuthState;

    if (
      typeof state.organizationId !== 'string'
      || typeof state.userId !== 'string'
      || typeof state.nonce !== 'string'
      || typeof state.returnTo !== 'string'
      || typeof state.expiresAt !== 'number'
      || state.nonce !== expectedNonce
      || state.expiresAt < Date.now()
    ) {
      return null;
    }

    return {
      ...state,
      // Estados assinados antes do cadastro de apps não têm estes campos.
      metaAppId: typeof state.metaAppId === 'string' ? state.metaAppId : null,
      groupId: typeof state.groupId === 'string' ? state.groupId : null,
    };
  } catch {
    return null;
  }
}

export function buildMetaAuthorizationUrl(state: string, redirectUri: string, clientId: string) {
  const url = new URL('https://api.instagram.com/oauth/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', META_OAUTH_SCOPES.join(','));
  url.searchParams.set('state', state);
  return url;
}

/**
 * Credencial global antiga, mantida apenas como retaguarda das conexões que já
 * existiam antes do cadastro de apps por organização. Conexões novas passam
 * obrigatoriamente por um app cadastrado em /meta, então estas funções devolvem
 * null em vez de lançar: a ausência da variável deixou de ser um erro.
 */
export function legacyMetaAppCredentials() {
  const clientId = process.env.INSTAGRAM_CLIENT_ID ?? process.env.META_CLIENT_ID;
  const clientSecret = process.env.INSTAGRAM_CLIENT_SECRET ?? process.env.META_CLIENT_SECRET;

  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function safeReturnTo(value: string | null) {
  return value?.startsWith('/') && !value.startsWith('//') ? value : '/perfis';
}
