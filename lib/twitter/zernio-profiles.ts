import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import {
  immutableTwitterUserId,
  stableZernioAccountId,
  type TwitterZernioAccount,
  type TwitterZernioHealth,
} from '@/lib/twitter/zernio-client';
import { loadTwitterZernioConnection } from '@/lib/twitter/zernio-connections';
import { safelyRecordTwitterObservabilityEvent } from '@/lib/twitter/observability-server';

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
  const admin = createSupabaseAdminClient();
  const { data: currentEpochs, error: epochError } = await admin.from('twitter_profile_connection_epochs')
    .select('zernio_account_id,profile_id')
    .eq('organization_id', organizationId).eq('connection_id', connectionId).is('ended_at', null);
  if (epochError) throw new Error('Não foi possível carregar as preferências de Analytics dos perfis.');
  const profileIds = [...new Set((currentEpochs ?? []).map((epoch) => epoch.profile_id))];
  const { data: currentProfiles, error: profileError } = profileIds.length
    ? await admin.from('twitter_profiles').select('id,analytics_enabled').in('id', profileIds)
    : { data: [], error: null };
  if (profileError) throw new Error('Não foi possível carregar as preferências de Analytics dos perfis.');
  const desiredByProfile = new Map((currentProfiles ?? []).map((profile) => [profile.id, profile.analytics_enabled !== false]));
  const desiredByAccount = new Map((currentEpochs ?? []).map((epoch) => [epoch.zernio_account_id, desiredByProfile.get(epoch.profile_id) !== false]));

  for (const account of accounts) {
    const accountId = stableZernioAccountId(account);
    if (accountId) await client.setAccountCapabilities(accountId, { analytics: desiredByAccount.get(accountId) !== false });
  }
  const { error: capabilityError } = await admin.from('twitter_connections').update({
    analytics_enabled: true,
    inbox_enabled: false,
  }).eq('id', connectionId).eq('organization_id', organizationId).is('deleted_at', null);
  if (capabilityError) throw new Error('O Analytics obrigatório não pôde ser ativado para a conexão X.');
  const analyticsHealth = health.map((item) => ({
    ...item,
    canFetchAnalytics: desiredByAccount.get(stableZernioAccountId(item) ?? '') !== false,
  }));

  return applyTwitterProfileInventory(organizationId, connectionId, accounts, analyticsHealth);
}

export async function applyTwitterProfileInventory(
  organizationId: string,
  connectionId: string,
  rawAccounts: TwitterZernioAccount[],
  rawHealth: TwitterZernioHealth[],
) {
  const accounts = rawAccounts.filter(
    (account) => account.platform?.toLowerCase() === 'twitter',
  );
  const health = rawHealth.filter(
    (account) => !account.platform || account.platform.toLowerCase() === 'twitter',
  );
  const admin = createSupabaseAdminClient();
  const { data: currentEpochRows } = await admin.from('twitter_profile_connection_epochs')
    .select('zernio_account_id,profile_id,twitter_profiles(username,status)')
    .eq('organization_id', organizationId).eq('connection_id', connectionId).is('ended_at', null);
  const previousByAccount = new Map((currentEpochRows ?? []).map((row) => [row.zernio_account_id, {
    profileId: row.profile_id,
    profile: (Array.isArray(row.twitter_profiles) ? row.twitter_profiles[0] : row.twitter_profiles) as { username?: string; status?: string } | null,
  }]));
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
    const result = data as Record<string, unknown>;
    synced.push(result);
    const previous = previousByAccount.get(accountId)?.profile?.status;
    const nextStatus = typeof result.status === 'string' ? result.status : null;
    if (previous && nextStatus && previous !== nextStatus) {
      const stableCode = nextStatus === 'needs_reauth' ? 'account_needs_reauth' : nextStatus === 'offline' ? 'account_cannot_post' : 'account_recovered';
      await safelyRecordTwitterObservabilityEvent(admin, {
        organizationId, domain: 'account', severity: nextStatus === 'active' ? 'info' : nextStatus === 'needs_reauth' ? 'critical' : 'error',
        stage: 'inventory_health', eventType: 'account_status_changed', stableCode,
        message: nextStatus === 'active' ? `Conta @${username} recuperada.` : `Conta @${username} mudou de ${previous} para ${nextStatus}.`,
        sourceType: 'profile_health_transition', sourceId: `${String(result.profileId)}:${Date.now()}:${nextStatus}`,
        profileId: typeof result.profileId === 'string' ? result.profileId : null, connectionId,
        evidence: { previousStatus: previous, status: nextStatus, tokenValid: state?.tokenValid !== false, needsReconnect: state?.needsReconnect === true, canPost: state?.canPost === true, issues: cleanIssues(state?.issues) },
      });
    }
  }

  const { data: offlineCount, error: offlineError } = await admin.rpc('twitter_mark_missing_connection_profiles_offline', {
    p_organization_id: organizationId,
    p_connection_id: connectionId,
    p_seen_zernio_account_ids: seenIds,
  });
  if (offlineError) throw new Error('Não foi possível fechar o inventário da conexão X.');
  for (const [accountId, previous] of previousByAccount) if (!seenIds.includes(accountId) && previous.profile?.status !== 'offline') {
    await safelyRecordTwitterObservabilityEvent(admin, {
      organizationId, domain: 'account', severity: 'critical', stage: 'inventory_health', eventType: 'account_status_changed', stableCode: 'account_missing_from_inventory',
      message: `Conta @${previous.profile?.username ?? 'desconhecida'} não apareceu no inventário Zernio.`,
      sourceType: 'profile_health_transition', sourceId: `${previous.profileId}:${Date.now()}:missing`, profileId: previous.profileId, connectionId,
      evidence: { previousStatus: previous.profile?.status ?? null, status: 'offline', reason: 'missing_inventory' },
    });
  }

  await admin.from('twitter_connections').update({
    last_sync_at: new Date().toISOString(),
    remote_twitter_account_count: seenIds.length,
    remote_inventory_checked_at: new Date().toISOString(),
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

export async function applyTwitterProfileAccount(
  organizationId: string,
  connectionId: string,
  account: TwitterZernioAccount,
  state?: TwitterZernioHealth,
) {
  const accountId = stableZernioAccountId(account);
  const username = typeof account.username === 'string' ? account.username.replace(/^@/, '').trim() : '';
  if (!accountId || !username || account.platform?.toLowerCase() !== 'twitter') {
    throw new Error('A Zernio não retornou a conta X esperada para esta solicitação.');
  }
  const admin = createSupabaseAdminClient();
  const { data: connection } = await admin.from('twitter_connections')
    .select('analytics_enabled').eq('id', connectionId).eq('organization_id', organizationId).single();
  const { data, error } = await admin.rpc('twitter_sync_profile_from_zernio', {
    p_organization_id: organizationId,
    p_connection_id: connectionId,
    p_zernio_account_id: accountId,
    p_twitter_user_id: immutableTwitterUserId(account),
    p_username: username,
    p_display_name: typeof account.displayName === 'string' ? account.displayName : null,
    p_avatar_url: avatar(account),
    p_can_post: state?.canPost === true,
    p_can_fetch_analytics: connection?.analytics_enabled === true && state?.canFetchAnalytics !== false,
    p_token_valid: state?.tokenValid !== false,
    p_needs_reconnect: state?.needsReconnect === true,
    p_account_tier: accountTier(account),
    p_health_issues: cleanIssues(state?.issues),
  });
  if (error || !data) throw new Error(`Não foi possível concluir a conexão de @${username}.`);
  await admin.from('twitter_connections').update({
    last_sync_at: new Date().toISOString(), last_error_code: null, last_error_message: null,
  }).eq('id', connectionId).eq('organization_id', organizationId);
  return data as { profileId: string; epochId: string; status: string };
}
