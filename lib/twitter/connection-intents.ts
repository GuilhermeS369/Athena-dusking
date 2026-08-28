import { randomBytes, randomUUID } from 'node:crypto';

import { decryptToken, encryptToken, tokenFingerprint } from '@/lib/security/token-crypto';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

const ACCESS_DOMAIN = 'athena:twitter:connect-intent-access:v1';
const CALLBACK_DOMAIN = 'athena:twitter:connect-intent-callback:v1';

function secret() { return randomBytes(32).toString('base64url'); }

export function connectionIntentTokenHash(value: string) {
  return tokenFingerprint(value, ACCESS_DOMAIN);
}

export function connectionIntentCallbackHash(value: string) {
  return tokenFingerprint(value, CALLBACK_DOMAIN);
}

export async function enqueueTwitterConnectionIntent(input: {
  organizationId: string;
  connectionId: string;
  groupId: string | null;
  actorUserId: string;
  idempotencyKey: string;
  origin: string;
}) {
  const intentId = randomUUID();
  const accessToken = secret();
  const callbackToken = secret();
  const expiresAt = new Date(Date.now() + 20 * 60_000).toISOString();
  const { data, error } = await createSupabaseAdminClient().rpc('twitter_enqueue_connection_intent', {
    p_intent_id: intentId,
    p_organization_id: input.organizationId,
    p_connection_id: input.connectionId,
    p_group_id: input.groupId,
    p_created_by: input.actorUserId,
    p_idempotency_key: input.idempotencyKey,
    p_access_token_hash: connectionIntentTokenHash(accessToken),
    p_callback_token_hash: connectionIntentCallbackHash(callbackToken),
    p_encrypted_callback_token: encryptToken(callbackToken),
    p_expires_at: expiresAt,
  });
  if (error) throw new Error(error.message.includes('vaga') ? 'Esta conexão Zernio X não possui vaga livre agora. Atualize o Bulk e tente outra linha.' : error.message);
  const outcome = data as { intentId?: string; status?: string; idempotentReplay?: boolean };
  if (outcome.idempotentReplay) {
    throw new Error('Esta solicitação já foi enviada. Use o navegador original para acompanhar o andamento.');
  }
  return { intentId, accessToken, expiresAt, status: outcome.status ?? 'queued' };
}

export function buildTwitterIntentCallbackUrl(origin: string, intentId: string, callbackToken: string) {
  const url = new URL('/api/x/integrations/zernio/connect-intents/callback', origin);
  url.searchParams.set('intent', intentId);
  url.searchParams.set('token', callbackToken);
  return url.toString();
}

export function encryptTwitterAuthUrl(url: string) { return encryptToken(url); }
export function decryptTwitterAuthUrl(payload: string) { return decryptToken(payload); }
