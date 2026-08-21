import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const META_OAUTH_COOKIE = 'athena-meta-oauth';
export const META_GRAPH_API_VERSION = process.env.META_GRAPH_API_VERSION ?? 'v26.0';
export const META_OAUTH_SCOPES = [
  'instagram_business_basic',
  'instagram_business_content_publish',
];

type OAuthState = {
  organizationId: string;
  userId: string;
  nonce: string;
  returnTo: string;
  expiresAt: number;
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

export function createSignedState(input: Omit<OAuthState, 'nonce' | 'expiresAt'>) {
  const state: OAuthState = {
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

    return state;
  } catch {
    return null;
  }
}

export function buildMetaAuthorizationUrl(state: string, redirectUri: string) {
  const url = new URL('https://api.instagram.com/oauth/authorize');
  url.searchParams.set('client_id', metaClientId());
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', META_OAUTH_SCOPES.join(','));
  url.searchParams.set('state', state);
  return url;
}

export function metaClientSecret() {
  const value = process.env.INSTAGRAM_CLIENT_SECRET ?? process.env.META_CLIENT_SECRET;
  if (!value) throw new Error('A variável INSTAGRAM_CLIENT_SECRET não está configurada.');
  return value;
}

export function metaClientId() {
  const value = process.env.INSTAGRAM_CLIENT_ID ?? process.env.META_CLIENT_ID;
  if (!value) throw new Error('A variável INSTAGRAM_CLIENT_ID não está configurada.');
  return value;
}

export function safeReturnTo(value: string | null) {
  return value?.startsWith('/') && !value.startsWith('//') ? value : '/perfis';
}
