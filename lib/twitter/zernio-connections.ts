import { randomUUID } from 'node:crypto';

import { encryptToken, decryptToken, tokenFingerprint } from '@/lib/security/token-crypto';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { createTwitterZernioClient, isTwitterOnlyAccountInventory } from '@/lib/twitter/zernio-client';

export const TWITTER_ZERNIO_KEY_FINGERPRINT_DOMAIN = 'athena:twitter:zernio-api-key:v1';

type ProvisionInput = {
  organizationId: string;
  organizationName: string;
  actorUserId: string;
  actorEmail?: string;
  label: string;
  apiKey: string;
  initialGrantMicros?: number;
  twitterSlotLimit?: number;
  rejectExistingConnection?: boolean;
  importItemId?: string;
};

function cleanLabel(value: string) {
  return value.trim().replace(/\s+/g, ' ');
}

function profileId(value: { _id?: string; id?: string } | undefined) {
  return value?._id ?? value?.id ?? null;
}

export async function provisionTwitterZernioConnection(input: ProvisionInput) {
  const label = cleanLabel(input.label);
  const apiKey = input.apiKey.trim();
  if (label.length < 2 || label.length > 120) throw new Error('Informe um nome entre 2 e 120 caracteres.');
  if (apiKey.length < 12 || apiKey.length > 2_000) throw new Error('Informe uma API key Zernio válida.');
  const initialGrantMicros = input.initialGrantMicros ?? 12_000_000;
  const twitterSlotLimit = input.twitterSlotLimit ?? 2;
  if (!Number.isSafeInteger(initialGrantMicros) || initialGrantMicros < 15_000 || initialGrantMicros > 1_000_000_000_000) {
    throw new Error('O saldo inicial configurado para esta linha é inválido.');
  }
  if (!Number.isInteger(twitterSlotLimit) || twitterSlotLimit < 1 || twitterSlotLimit > 100) {
    throw new Error('O limite de contas X desta conexão é inválido.');
  }

  const client = createTwitterZernioClient(apiKey);
  const verification = await client.verifyAuth();
  const userId = typeof verification.userId === 'string' ? verification.userId.trim() : '';
  if (verification.valid === false || !userId) throw new Error('A Zernio não confirmou a identidade estável desta API key.');

  const admin = createSupabaseAdminClient();
  const fingerprint = tokenFingerprint(apiKey, TWITTER_ZERNIO_KEY_FINGERPRINT_DOMAIN);
  if (!input.importItemId) {
    const { error: reserveError } = await admin.from('twitter_api_key_registry').insert({
      api_key_fingerprint: fingerprint,
      organization_id: input.organizationId,
      status: 'reserved',
    });
    if (reserveError) throw new Error('Esta API key Zernio já está cadastrada ou reservada.');
  }
  const { data: wallet, error: walletError } = await admin.rpc('twitter_register_identity_and_grant', {
    p_organization_id: input.organizationId,
    p_zernio_user_id: userId,
    p_initial_grant_micros: initialGrantMicros,
  });
  if (walletError || !wallet) {
    if (walletError?.code === '23505') throw new Error('Esta identidade Zernio já está vinculada a outra organização Athena.');
    throw new Error('Não foi possível registrar a carteira Athena desta identidade Zernio.');
  }

  const identityId = String((wallet as Record<string, unknown>).identityId);
  if (input.rejectExistingConnection) {
    const { data: existingConnection } = await admin.from('twitter_connections')
      .select('id,label')
      .eq('organization_id', input.organizationId)
      .eq('identity_id', identityId)
      .is('deleted_at', null)
      .neq('status', 'deleted')
      .maybeSingle();
    if (existingConnection) throw new Error(`Esta identidade Zernio já está cadastrada como “${existingConnection.label}”.`);
  }

  const canonicalProfileName = `${input.organizationName} · X · ${label}`.slice(0, 180);
  const listed = await client.listProfiles();
  const existingProfile = listed.profiles?.find((item) => item.name?.trim() === canonicalProfileName);
  let zernioProfileId = profileId(existingProfile);
  let adoptedExistingProfile = false;
  if (!zernioProfileId && listed.profiles?.length === 1) {
    const soleProfileId = profileId(listed.profiles[0]);
    if (soleProfileId) {
      const inventory = await client.listAccounts(soleProfileId);
      if (isTwitterOnlyAccountInventory(inventory.accounts ?? [])) {
        zernioProfileId = soleProfileId;
        adoptedExistingProfile = true;
      }
    }
  }
  if (!zernioProfileId) {
    const created = await client.createProfile(
      canonicalProfileName,
      `athena-twitter-profile:${identityId}`,
    );
    zernioProfileId = profileId(created.profile);
  }
  if (!zernioProfileId) throw new Error('A Zernio não retornou o ID do profile dedicado ao X.');

  const scope = Array.isArray(verification.scope) ? verification.scope.join(' ') : verification.scope;
  const { data: connection, error: connectionError } = await admin.rpc('twitter_upsert_connection_credentials', {
    p_organization_id: input.organizationId,
    p_identity_id: String((wallet as Record<string, unknown>).identityId),
    p_label: label,
    p_zernio_profile_id: zernioProfileId,
    p_encrypted_api_key: encryptToken(apiKey),
    p_api_key_fingerprint: fingerprint,
    p_auth_type: verification.authType ?? null,
    p_auth_scope: scope ?? null,
    p_actor_user_id: input.actorUserId,
    p_actor_email: input.actorEmail ?? null,
  });
  if (connectionError || !connection) throw new Error('Não foi possível persistir a conexão Zernio do X.');

  const connectionId = String((connection as Record<string, unknown>).connectionId);
  const { error: slotError } = await admin.from('twitter_connections').update({
    twitter_slot_limit: twitterSlotLimit,
  }).eq('id', connectionId).eq('organization_id', input.organizationId);
  if (slotError) throw new Error('A conexão foi validada, mas o limite de contas X não pôde ser salvo.');

  if (input.importItemId) {
    const { data: registry, error: registryError } = await admin.from('twitter_api_key_registry').update({
      connection_id: connectionId,
      status: 'active',
    }).eq('api_key_fingerprint', fingerprint)
      .eq('organization_id', input.organizationId)
      .eq('import_item_id', input.importItemId)
      .select('api_key_fingerprint')
      .maybeSingle();
    if (registryError || !registry) throw new Error('A conexão foi validada, mas a reserva antifraude da API key não foi consolidada.');
  } else {
    const { error: registryError } = await admin.from('twitter_api_key_registry').update({
      connection_id: connectionId, status: 'active',
    }).eq('api_key_fingerprint', fingerprint).eq('organization_id', input.organizationId);
    if (registryError) throw new Error('Não foi possível consolidar a proteção contra API key duplicada.');
  }

  return {
    connection: connection as Record<string, unknown>,
    wallet: wallet as Record<string, unknown>,
    adoptedExistingProfile,
  };
}

export async function loadTwitterZernioConnection(organizationId: string, connectionId: string) {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from('twitter_connections')
    .select('id, organization_id, identity_id, label, zernio_profile_id, status, analytics_enabled, inbox_enabled, twitter_connection_secrets!inner(encrypted_api_key)')
    .eq('id', connectionId)
    .eq('organization_id', organizationId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error || !data) throw new Error('Conexão Zernio do X não encontrada.');
  const secretRelation = data.twitter_connection_secrets as unknown;
  const secret = Array.isArray(secretRelation) ? secretRelation[0] : secretRelation;
  const encryptedApiKey = (secret as { encrypted_api_key?: string } | null)?.encrypted_api_key;
  if (!encryptedApiKey) throw new Error('Credencial da conexão Zernio do X indisponível.');
  return {
    connection: data,
    client: createTwitterZernioClient(decryptToken(encryptedApiKey)),
  };
}

export async function createTwitterOAuthAttempt(input: {
  organizationId: string;
  connectionId: string;
  actorUserId: string;
  origin: string;
}) {
  const { connection, client } = await loadTwitterZernioConnection(input.organizationId, input.connectionId);
  if (!connection.zernio_profile_id) throw new Error('A conexão não possui profile Zernio preparado.');
  const admin = createSupabaseAdminClient();
  const attemptId = randomUUID();
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  const callbackUrl = new URL('/api/x/integrations/zernio/callback', input.origin);
  callbackUrl.searchParams.set('attempt', attemptId);
  const { error } = await admin.rpc('twitter_reserve_oauth_attempt', {
    p_attempt_id: attemptId,
    p_organization_id: input.organizationId,
    p_connection_id: input.connectionId,
    p_created_by: input.actorUserId,
    p_expires_at: expiresAt,
  });
  if (error) {
    if (error.message.includes('limite')) throw new Error('Esta conexão Zernio atingiu o limite de contas X. Aumente o limite em Configurar ou use outra conexão.');
    throw new Error('Não foi possível reservar uma vaga para a tentativa OAuth do X.');
  }
  try {
    const result = await client.startTwitterConnect(connection.zernio_profile_id, callbackUrl.toString());
    if (!result.authUrl) throw new Error('A Zernio não retornou a URL de autorização do X.');
    await admin.from('twitter_connection_events').insert({
      organization_id: input.organizationId,
      connection_id: input.connectionId,
      event_type: 'oauth_started',
      actor_user_id: input.actorUserId,
      message: 'Autorização X iniciada.',
      metadata: { attemptId, expiresAt },
    });
    return { attemptId, authUrl: result.authUrl, expiresAt };
  } catch (error) {
    await admin.from('twitter_connection_oauth_attempts').update({
      status: 'failed',
      error_code: 'zernio_connect_failed',
      error_message: error instanceof Error ? error.message.slice(0, 500) : 'Falha ao iniciar OAuth.',
    }).eq('id', attemptId);
    throw error;
  }
}
