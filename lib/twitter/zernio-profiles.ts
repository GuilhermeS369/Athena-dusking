import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import {
  immutableTwitterUserId,
  stableZernioAccountId,
  type TwitterZernioAccount,
  type TwitterZernioHealth,
} from '@/lib/twitter/zernio-client';
import { loadTwitterZernioConnection } from '@/lib/twitter/zernio-connections';

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function avatar(account: TwitterZernioAccount) {
  return [account.profilePictureUrl, account.profilePicture, account.avatarUrl]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0) ?? null;
}

function accountTier(account: TwitterZernioAccount): 'unknown' | 'free' | 'premium' {
  const metadata = object(account.metadata);
  const profileData = object(account.profileData);
  const candidate = [account.accountTier, account.subscriptionTier, metadata.accountTier, profileData.accountTier]
    .find((value): value is string => typeof value === 'string')?.toLowerCase();
  if (candidate === 'premium') return 'premium';
  if (candidate === 'free') return 'free';
  return 'unknown';
}

function healthFor(accountId: string, health: TwitterZernioHealth[]) {
  return health.find((item) => stableZernioAccountId(item) === accountId);
}

function cleanIssues(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map((item) => {
    if (typeof item === 'string') return item.slice(0, 500);
    const record = object(item);
    return String(record.message ?? record.code ?? 'Problema informado pela Zernio').slice(0, 500);
  });
}

export async function syncTwitterProfiles(organizationId: string, connectionId: string) {
  const { connection, client } = await loadTwitterZernioConnection(organizationId, connectionId);
  if (!connection.zernio_profile_id) throw new Error('Conexão sem profile Zernio dedicado.');
  const [accountsResponse, healthResponse] = await Promise.all([
    client.listTwitterAccounts(connection.zernio_profile_id),
    client.getTwitterAccountHealth(connection.zernio_profile_id),
  ]);
  const accounts = (accountsResponse.accounts ?? []).filter((account) => account.platform?.toLowerCase() === 'twitter');
  const health = healthResponse.accounts ?? [];

  for (const account of accounts) {
    const accountId = stableZernioAccountId(account);
    if (accountId) await client.setAccountCapabilities(accountId, { analytics: connection.analytics_enabled === true }).catch(() => null);
  }

  return applyTwitterProfileInventory(organizationId, connectionId, accounts, health);
}

export async function applyTwitterProfileInventory(
  organizationId: string,
  connectionId: string,
  rawAccounts: TwitterZernioAccount[],
  rawHealth: TwitterZernioHealth[],
) {
  if (rawAccounts.length > 500 || rawHealth.length > 500) {
    throw new Error('Inventário X excede o limite seguro de 500 contas.');
  }
  const accounts = rawAccounts.filter(
    (account) => account.platform?.toLowerCase() === 'twitter',
  );
  const health = rawHealth.filter(
    (account) => !account.platform || account.platform.toLowerCase() === 'twitter',
  );
  const admin = createSupabaseAdminClient();
  const seenIds: string[] = [];
  const synced: Record<string, unknown>[] = [];

  for (const account of accounts) {
    const accountId = stableZernioAccountId(account);
    const username = typeof account.username === 'string' ? account.username.replace(/^@/, '').trim() : '';
    if (!accountId || !username) continue;
    seenIds.push(accountId);
    const state = healthFor(accountId, health);

    const { data, error } = await admin.rpc('twitter_sync_profile_from_zernio', {
      p_organization_id: organizationId,
      p_connection_id: connectionId,
      p_zernio_account_id: accountId,
      p_twitter_user_id: immutableTwitterUserId(account),
      p_username: username,
      p_display_name: typeof account.displayName === 'string' ? account.displayName : null,
      p_avatar_url: avatar(account),
      p_can_post: state?.canPost === true,
      p_can_fetch_analytics: state?.canFetchAnalytics === true,
      p_token_valid: state?.tokenValid !== false,
      p_needs_reconnect: state?.needsReconnect === true,
      p_account_tier: accountTier(account),
      p_health_issues: cleanIssues(state?.issues),
    });
    if (error) throw new Error(`Não foi possível sincronizar o perfil @${username}.`);
    synced.push(data as Record<string, unknown>);
  }

  const { data: offlineCount, error: offlineError } = await admin.rpc('twitter_mark_missing_connection_profiles_offline', {
    p_organization_id: organizationId,
    p_connection_id: connectionId,
    p_seen_zernio_account_ids: seenIds,
  });
  if (offlineError) throw new Error('Não foi possível fechar o inventário da conexão X.');

  await admin.from('twitter_connections').update({
    last_sync_at: new Date().toISOString(),
    last_error_code: null,
    last_error_message: null,
  }).eq('id', connectionId).eq('organization_id', organizationId);
  await admin.from('twitter_connection_events').insert({
    organization_id: organizationId,
    connection_id: connectionId,
    event_type: 'sync_completed',
    message: 'Inventário X sincronizado.',
    metadata: { seen: seenIds.length, synced: synced.length, markedOffline: Number(offlineCount ?? 0) },
  });
  return { seen: seenIds.length, synced: synced.length, markedOffline: Number(offlineCount ?? 0), profiles: synced };
}
