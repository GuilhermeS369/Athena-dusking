import { randomUUID } from 'node:crypto';

import { createZernioClient, isZernioAuthenticationError, isZernioPlanLimitError } from '@/lib/integrations/zernio-client';
import { decryptToken, encryptToken, tokenFingerprint } from '@/lib/security/token-crypto';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { fetchAllRows } from '@/lib/supabase/paginate';

type ProvisionZernioConnectionInput = {
  organizationId: string;
  organizationName: string;
  createdBy: string;
  label: string;
  apiKey: string;
  apiKeyFingerprint?: string;
  credentialClaimOwner?: string;
  instagramSlotLimit?: number;
};

export type ProvisionZernioConnectionResult = {
  id: string;
  warning: string | null;
  status: 'online' | 'offline';
};

type ActiveCredentialRow = {
  id: string;
  organization_id: string;
  label: string;
  encrypted_api_key: string;
  api_key_fingerprint: string | null;
};

export const ZERNIO_API_KEY_FINGERPRINT_DOMAIN = 'athena:zernio-api-key:v1';

export class ZernioDuplicateApiKeyError extends Error {
  readonly code = 'zernio_duplicate_api_key';

  constructor(readonly existingLabel: string) {
    super(`Esta API key já está cadastrada na conta Zernio “${existingLabel}”. Use uma chave diferente.`);
    this.name = 'ZernioDuplicateApiKeyError';
  }
}

export function zernioApiKeyFingerprint(apiKey: string) {
  return tokenFingerprint(apiKey, ZERNIO_API_KEY_FINGERPRINT_DOMAIN);
}

function storedCredentialFingerprint(connection: ActiveCredentialRow) {
  if (connection.api_key_fingerprint) return connection.api_key_fingerprint;
  try {
    return zernioApiKeyFingerprint(decryptToken(connection.encrypted_api_key));
  } catch {
    return null;
  }
}

export function normalizeZernioConnectionLabel(value: unknown) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

export function zernioPlanLimitMessage() {
  return 'Conta Zernio salva. A Zernio bloqueou a validação/preparação por limite do plano ou forma de pagamento. A chave permanece disponível para nova tentativa depois que o limite for resolvido na Zernio.';
}

/**
 * Cria uma conexão de forma idempotente pelo índice único organização/nome.
 * A API key nunca é retornada nem incluída em mensagens de erro.
 */
export async function provisionZernioConnection(input: ProvisionZernioConnectionInput): Promise<ProvisionZernioConnectionResult> {
  const label = normalizeZernioConnectionLabel(input.label);
  const apiKey = input.apiKey.trim();
  if (label.length < 2 || label.length > 80) throw new Error('Informe um nome entre 2 e 80 caracteres para esta conta Zernio.');
  if (apiKey.length < 12 || apiKey.length > 2000) throw new Error('Informe uma API key Zernio válida.');

  const admin = createSupabaseAdminClient();
  const apiKeyFingerprint = input.apiKeyFingerprint ?? zernioApiKeyFingerprint(apiKey);
  const credentialClaimOwner = input.credentialClaimOwner ?? randomUUID();
  let credentialClaimed = false;
  let connectionSaved = false;
  let instagramSlotLimit = input.instagramSlotLimit;
  if (!Number.isInteger(instagramSlotLimit) || (instagramSlotLimit ?? 0) < 1 || (instagramSlotLimit ?? 0) > 100) {
    const { data: settings } = await admin
      .from('zernio_multi_connection_settings')
      .select('default_instagram_slot_limit')
      .eq('organization_id', input.organizationId)
      .maybeSingle();
    instagramSlotLimit = settings?.default_instagram_slot_limit ?? 2;
  }
  const { data: existing } = await admin
    .from('zernio_connections')
    .select('id')
    .eq('organization_id', input.organizationId)
    .is('deleted_at', null)
    .ilike('label', label)
    .maybeSingle();
  if (existing?.id) {
    if (input.credentialClaimOwner) {
      await admin.rpc('release_zernio_api_key_claim', {
        p_api_key_fingerprint: apiKeyFingerprint,
        p_owner_token: credentialClaimOwner,
      });
    }
    return { id: existing.id, status: 'online', warning: 'Já existia uma conta Zernio ativa com esse nome; a linha foi concluída sem duplicar o cadastro.' };
  }

  // Mesma varredura global do /import-batches: sem paginar, a colisão de API key
  // deixa de ser detectada assim que o sistema passa de 1.000 conexões Zernio.
  const { data: activeCredentials, error: activeCredentialsError } = await fetchAllRows<ActiveCredentialRow>((from, to) => admin
    .from('zernio_connections')
    .select('id, organization_id, label, encrypted_api_key, api_key_fingerprint')
    .is('deleted_at', null)
    .order('id', { ascending: true })
    .range(from, to));
  if (activeCredentialsError) throw new Error('Não foi possível verificar se a API key já está cadastrada.');

  const credentialCollision = activeCredentials
    .find((connection) => storedCredentialFingerprint(connection) === apiKeyFingerprint);
  if (credentialCollision) {
    throw new ZernioDuplicateApiKeyError(
      credentialCollision.organization_id === input.organizationId
        ? credentialCollision.label
        : 'outra organização',
    );
  }

  const { data: claimData, error: claimError } = await admin.rpc('claim_zernio_api_key', {
    p_organization_id: input.organizationId,
    p_api_key_fingerprint: apiKeyFingerprint,
    p_label: label,
    p_owner_token: credentialClaimOwner,
    p_import_item_id: input.credentialClaimOwner ? credentialClaimOwner : null,
    p_lease_seconds: 7200,
  });
  if (claimError) throw new Error('Não foi possível reservar a API key para o cadastro.');
  const claim = claimData as { claimed?: boolean; existingLabel?: string | null } | null;
  if (!claim?.claimed) {
    throw new ZernioDuplicateApiKeyError(claim?.existingLabel ?? 'outra conexão');
  }
  credentialClaimed = true;

  try {
    const client = createZernioClient(apiKey);
    let zernioProfileId: string | null = null;
    let status: 'online' | 'offline' = 'online';
    let lastErrorCode: string | null = null;
    let lastErrorMessage: string | null = null;
    let balanceCents = 0;
    let balanceCurrency = 'USD';
    let billingMetadata: Record<string, unknown> | null = null;
    let remoteInstagramAccountCount: number | null = null;

    try {
      const accounts = await client.listAccounts();
      // Uma chave pode enxergar profiles externos. Antes de existir o profile
      // canônico desta conexão, nenhum deles pode ser contabilizado como slot
      // dela; o inventário será atualizado após a criação do profile.
      remoteInstagramAccountCount = 0;
    } catch (error) {
      if (isZernioAuthenticationError(error)) throw error;
      status = 'offline';
      lastErrorCode = isZernioPlanLimitError(error) ? 'zernio_plan_limit' : 'zernio_key_validation_warning';
      lastErrorMessage = isZernioPlanLimitError(error)
        ? zernioPlanLimitMessage()
        : error instanceof Error ? `Conta salva, mas a Zernio retornou um aviso ao validar: ${error.message}` : 'Conta salva, mas a Zernio retornou um aviso ao validar.';
    }

    try {
      const created = await client.createProfile(`${input.organizationName} · ${label}`);
      zernioProfileId = created.profile?._id ?? created.profile?.id ?? null;
      if (!zernioProfileId) throw new Error('A Zernio não retornou o ID do profile criado.');
      const accounts = await client.listAccounts();
      remoteInstagramAccountCount = (accounts.accounts ?? []).filter((account) => {
        if (account.platform !== 'instagram') return false;
        const profileId = typeof account.profileId === 'string' ? account.profileId : account.profileId?._id;
        return profileId === zernioProfileId;
      }).length;
    } catch (error) {
      if (isZernioAuthenticationError(error)) throw error;
      status = 'offline';
      lastErrorCode = isZernioPlanLimitError(error) ? 'zernio_plan_limit' : 'zernio_profile_prepare_failed';
      lastErrorMessage = isZernioPlanLimitError(error)
        ? zernioPlanLimitMessage()
        : error instanceof Error ? `Conta salva, mas não foi possível preparar o profile Zernio agora: ${error.message}` : 'Conta salva, mas não foi possível preparar o profile Zernio agora.';
    }

    try {
      const billing = await client.getBilling();
      const credits = billing.balance?.creditsRemainingCents;
      const accrued = billing.balance?.accruedThisPeriodCents;
      balanceCents = typeof credits === 'number' && Number.isFinite(credits) ? Math.round(credits) : 0;
      balanceCurrency = typeof billing.balance?.currency === 'string' && billing.balance.currency.trim().length >= 3 ? billing.balance.currency.trim().toUpperCase().slice(0, 8) : 'USD';
      billingMetadata = {
        plan: billing.plan ?? null,
        cycle: billing.cycle ?? null,
        balance: billing.balance ?? null,
        creditsRemainingCents: balanceCents,
        accruedThisPeriodCents: typeof accrued === 'number' && Number.isFinite(accrued) ? Math.round(accrued) : 0,
        currency: balanceCurrency,
        syncedAt: new Date().toISOString(),
      };
    } catch {
      billingMetadata = null;
    }

    const checkedAt = new Date().toISOString();
    const { data, error } = await admin
    .from('zernio_connections')
    .insert({
      organization_id: input.organizationId,
      label,
      encrypted_api_key: encryptToken(apiKey),
      api_key_fingerprint: apiKeyFingerprint,
      zernio_profile_id: zernioProfileId,
      status,
      balance_cents: balanceCents,
      balance_currency: balanceCurrency,
      supported_platforms: ['instagram'],
      instagram_slot_limit: instagramSlotLimit,
      remote_instagram_account_count: remoteInstagramAccountCount,
      remote_inventory_checked_at: remoteInstagramAccountCount === null ? null : checkedAt,
      remote_inventory_error_code: remoteInstagramAccountCount === null ? lastErrorCode : null,
      remote_inventory_error_message: remoteInstagramAccountCount === null ? lastErrorMessage : null,
      metadata: billingMetadata ? { billing: billingMetadata } : {},
      last_checked_at: checkedAt,
      last_success_at: status === 'online' ? checkedAt : null,
      last_failure_at: status === 'offline' ? checkedAt : null,
      last_error_code: lastErrorCode,
      last_error_message: lastErrorMessage,
      created_by: input.createdBy,
    })
    .select('id')
    .single();

    if (error) {
      if (error.code === '23505' || error.message?.toLowerCase().includes('duplicate')) {
        const { data: credentialCollision } = await admin
          .from('zernio_connections')
          .select('organization_id, label')
          .eq('api_key_fingerprint', apiKeyFingerprint)
          .is('deleted_at', null)
          .maybeSingle();
        if (credentialCollision?.label) throw new ZernioDuplicateApiKeyError(credentialCollision.label);

        const { data: collided } = await admin
          .from('zernio_connections')
          .select('id')
          .eq('organization_id', input.organizationId)
          .is('deleted_at', null)
          .ilike('label', label)
          .maybeSingle();
        if (collided?.id) return { id: collided.id, status: 'online', warning: 'Outra operação acabou de cadastrar este nome; a linha foi concluída sem duplicidade.' };
      }
      throw new Error('Não foi possível salvar a conta Zernio.');
    }

    const { data: finalized, error: finalizeError } = await admin.rpc('finalize_zernio_api_key_claim', {
      p_api_key_fingerprint: apiKeyFingerprint,
      p_owner_token: credentialClaimOwner,
      p_connection_id: data.id,
    });
    if (finalizeError || !finalized) {
      await admin.from('zernio_connections').delete().eq('id', data.id);
      throw new Error('Não foi possível finalizar a proteção da API key Zernio.');
    }
    connectionSaved = true;
    return { id: data.id, status, warning: lastErrorMessage };
  } finally {
    if (credentialClaimed && !connectionSaved) {
      await admin.rpc('release_zernio_api_key_claim', {
        p_api_key_fingerprint: apiKeyFingerprint,
        p_owner_token: credentialClaimOwner,
      });
    }
  }
}
