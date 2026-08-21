import { knownZernioAccountIdsFromAttempt, loadZernioConnectionAttempt, markZernioConnectionAttemptFailed, markZernioConnectionAttemptSynced } from '@/lib/integrations/zernio-attempts';
import { withZernioConnectionOperationLease } from '@/lib/integrations/zernio-concurrency';
import { createZernioConnectionContext, refreshZernioConnectionBilling, type ZernioAccount, type ZernioClient } from '@/lib/integrations/zernio-client';
import { initializeProfileAnalyticsState } from '@/lib/integrations/zernio-analytics';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { selectNewZernioAccountsForAttempt, selectZernioInstagramAccountsForSync, zernioAccountIdentitySnapshot, type ZernioAccountIdentitySnapshot } from './zernio-account-selection';

export { selectNewZernioAccountsForAttempt, selectZernioInstagramAccountsForSync } from './zernio-account-selection';

type CreatedRefreshJob = { job_id: string; status: string; total_count: number; reused: boolean; reason: string };
type ZernioReconciliationStatus = 'created' | 'updated' | 'unchanged' | 'conflict';
type ZernioReconciliationRow = {
  profile_id: string | null;
  result_status: ZernioReconciliationStatus;
  conflict_reason: string | null;
};
type SyncZernioInstagramAccountsOptions = { attemptId?: string; maxListAttempts?: number; listRetryDelayMs?: number };
type ZernioConnectionHealthSummary = {
  available: boolean;
  total: number;
  healthy: number;
  unhealthy: number;
  error: string | null;
};
export type ZernioOrganizationSyncResult = {
  status: 'completed' | 'already_running' | 'completed_with_errors';
  batchId: string | null;
  totalConnections: number;
  synced: number;
  conflicts: number;
  failures: number;
};
export type ZernioOrganizationSyncEnqueueResult = {
  status: 'queued' | 'already_running';
  batchId: string;
  totalConnections: number;
};
export type ZernioGroupAssignmentResult = {
  status: 'not_requested' | 'assigned' | 'failed';
  groupId: string | null;
  groupName: string | null;
  assignedProfileIds: string[];
  error: string | null;
};

function accountId(account: ZernioAccount) {
  return account.accountId ?? account._id ?? account.id ?? null;
}

function accountProfileId(account: ZernioAccount) {
  if (typeof account.profileId === 'string') return account.profileId;
  return account.profileId?._id ?? null;
}

function accountUsername(account: ZernioAccount, id: string) {
  return account.username?.replace(/^@/, '').trim() || id;
}

function accountProfilePicture(account: ZernioAccount) {
  const candidates = [
    account.profilePicture,
    account.profilePictureUrl,
    account.profileImageUrl,
    account.profileImage,
    account.avatarUrl,
    account.avatar,
    account.picture,
  ];
  return candidates.find((value): value is string => typeof value === 'string' && /^https?:\/\//i.test(value)) ?? null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function instagramAccountsForProfiles(accounts: ZernioAccount[], zernioProfileIds: string[]) {
  const profileIds = new Set(zernioProfileIds.filter(Boolean));
  if (profileIds.size === 0) return [];
  return accounts
    .filter((account) => account.platform === 'instagram')
    .filter((account) => {
      const profileId = accountProfileId(account);
      // Conta sem profileId é ambígua. Com vínculo canônico, somente uma
      // igualdade explícita pode autorizar baseline, inventário ou persistência.
      return Boolean(profileId && profileIds.has(profileId));
    });
}

function zernioAccountIds(accounts: ZernioAccount[]) {
  return accounts.map(accountId).filter((id): id is string => Boolean(id));
}

async function loadConnectionHealth(client: ZernioClient, remoteAccountIds: string[]): Promise<ZernioConnectionHealthSummary> {
  try {
    const response = await client.accountsHealth();
    const relevantIds = new Set(remoteAccountIds);
    const accounts = (response.accounts ?? []).filter((account) => {
      const id = accountId(account);
      return relevantIds.size === 0 || (id ? relevantIds.has(id) : false);
    });
    const unhealthy = accounts.filter((account) => account.canPost === false || !['healthy', 'online', 'active', 'ok'].includes(String(account.status ?? '').toLowerCase())).length;
    return {
      available: true,
      total: accounts.length,
      healthy: accounts.length - unhealthy,
      unhealthy,
      error: null,
    };
  } catch (error) {
    return {
      available: false,
      total: 0,
      healthy: 0,
      unhealthy: 0,
      error: error instanceof Error ? error.message : 'A saúde detalhada das contas não pôde ser consultada.',
    };
  }
}

export async function listZernioInstagramAccountIdsForConnection(client: ZernioClient, zernioProfileId: string) {
  const response = await client.listAccounts();
  return zernioAccountIds(instagramAccountsForProfiles(response.accounts ?? [], [zernioProfileId]));
}

export async function listZernioInstagramAccountSnapshotsForConnection(
  client: ZernioClient,
  zernioProfileId: string,
): Promise<ZernioAccountIdentitySnapshot[]> {
  const response = await client.listAccounts();
  return instagramAccountsForProfiles(response.accounts ?? [], [zernioProfileId])
    .map(zernioAccountIdentitySnapshot)
    .filter((snapshot): snapshot is ZernioAccountIdentitySnapshot => Boolean(snapshot));
}

export async function listZernioInstagramAccountIds(client: ZernioClient) {
  const response = await client.listAccounts();
  return zernioAccountIds((response.accounts ?? []).filter((account) => account.platform === 'instagram'));
}

export async function refreshZernioRemoteInventorySnapshot(organizationId: string, connectionId: string) {
  const admin = createSupabaseAdminClient();
  const { connection, client } = await createZernioConnectionContext(organizationId, connectionId);
  if (!connection.zernio_profile_id) throw new Error('A conexão Zernio não possui profile canônico para inventário.');
  const response = await client.listAccounts();
  const count = instagramAccountsForProfiles(response.accounts ?? [], [connection.zernio_profile_id]).length;
  const checkedAt = new Date().toISOString();
  const { error } = await admin
    .from('zernio_connections')
    .update({
      remote_instagram_account_count: count,
      remote_inventory_checked_at: checkedAt,
      remote_inventory_error_code: null,
      remote_inventory_error_message: null,
    })
    .eq('id', connectionId)
    .eq('organization_id', organizationId);
  if (error) throw error;
  return { count, checkedAt };
}

async function listInstagramAccountsWithRetry(input: {
  client: ZernioClient;
  zernioProfileIds: string[];
  knownIds: string[];
  isolateAttempt: boolean;
  maxAttempts: number;
  delayMs: number;
}) {
  const known = new Set(input.knownIds);
  let attempts = 0;
  let accounts: ZernioAccount[] = [];
  let ids: string[] = [];
  let newIds: string[] = [];

  for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
    attempts = attempt;
    const response = await input.client.listAccounts();
    accounts = selectZernioInstagramAccountsForSync(response.accounts ?? [], input.zernioProfileIds, input.isolateAttempt);
    ids = zernioAccountIds(accounts);
    newIds = ids.filter((id) => !known.has(id));
    if ((input.knownIds.length === 0 && ids.length > 0) || newIds.length > 0 || attempt === input.maxAttempts) break;
    await sleep(input.delayMs);
  }

  return { accounts, ids, newIds, attempts };
}

async function zernioProfileIdsForSync(organizationId: string, connectionId: string, primaryProfileId: string, attemptId?: string) {
  const attempt = attemptId ? await loadZernioConnectionAttempt(organizationId, attemptId) : null;
  if (attemptId && attempt?.zernio_profile_id) return { attempt, profileIds: [attempt.zernio_profile_id] };
  // Recuperações e sincronizações administrativas permanecem restritas ao
  // profile canônico atual. Attempts históricos não podem ampliar o escopo e
  // importar uma conta pertencente a outro profile exposto pela mesma API key.
  return { attempt, profileIds: [primaryProfileId] };
}

async function enqueueAnalyticsRefresh(organizationId: string, profileIds: string[]) {
  if (profileIds.length === 0) return null;
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc('enqueue_zernio_reconciliation_analytics', {
    p_organization_id: organizationId,
    p_profile_ids: [...new Set(profileIds)],
  });

  if (error) throw error;
  return ((data ?? []) as CreatedRefreshJob[])[0] ?? null;
}

async function assignAttemptProfilesToRequestedGroup(input: {
  organizationId: string;
  userId: string;
  attemptId?: string;
  profileIds: string[];
}) : Promise<ZernioGroupAssignmentResult> {
  if (!input.attemptId) {
    return { status: 'not_requested', groupId: null, groupName: null, assignedProfileIds: [], error: null };
  }

  const attempt = await loadZernioConnectionAttempt(input.organizationId, input.attemptId);
  if (!attempt?.requested_group_id) {
    return { status: 'not_requested', groupId: null, groupName: null, assignedProfileIds: [], error: null };
  }

  try {
    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase.rpc('assign_zernio_attempt_profiles_to_group', {
      p_organization_id: input.organizationId,
      p_attempt_id: input.attemptId,
      p_profile_ids: input.profileIds,
      p_added_by: input.userId,
    });
    if (error) throw error;
    const result = ((data ?? []) as Array<{ assignment_status: 'assigned' | 'failed'; assigned_profile_ids: string[] | null; error_message: string | null }>)[0];
    return {
      status: result?.assignment_status === 'assigned' ? 'assigned' : 'failed',
      groupId: attempt.requested_group_id,
      groupName: attempt.requested_group_name,
      assignedProfileIds: result?.assigned_profile_ids ?? [],
      error: result?.error_message ?? (result ? null : 'A associação ao grupo não retornou um resultado.'),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Não foi possível associar os perfis ao grupo.';
    try {
      await createSupabaseAdminClient()
        .from('zernio_connection_attempts')
        .update({
          group_assignment_status: 'failed',
          group_assignment_error: message.slice(0, 1000),
          group_assignment_completed_at: new Date().toISOString(),
        })
        .eq('id', input.attemptId)
        .eq('organization_id', input.organizationId);
    } catch {
      // O perfil já foi salvo; falhas de auditoria não devem desfazer a adição.
    }
    return {
      status: 'failed',
      groupId: attempt.requested_group_id,
      groupName: attempt.requested_group_name,
      assignedProfileIds: [],
      error: message,
    };
  }
}

export async function syncZernioInstagramAccounts(organizationId: string, userId: string, connectionId: string, options: SyncZernioInstagramAccountsOptions = {}) {
  return withZernioConnectionOperationLease(organizationId, connectionId, async (locked) => {
    if (!locked) throw new Error('Outra sincronização desta chave Zernio ainda está em andamento.');
    const admin = createSupabaseAdminClient();
    const { connection, client } = await createZernioConnectionContext(organizationId, connectionId);

    if (!connection.zernio_profile_id) {
      throw new Error('A conta Zernio selecionada ainda não tem um profile preparado para conexão.');
    }

    const { attempt, profileIds: zernioProfileIds } = await zernioProfileIdsForSync(organizationId, connectionId, connection.zernio_profile_id, options.attemptId);
    const knownIds = knownZernioAccountIdsFromAttempt(attempt);
    const listed = await listInstagramAccountsWithRetry({
      client,
      zernioProfileIds,
      knownIds,
      isolateAttempt: Boolean(options.attemptId),
      maxAttempts: Math.max(1, options.maxListAttempts ?? (options.attemptId ? 7 : 1)),
      delayMs: Math.max(100, options.listRetryDelayMs ?? 900),
    });
    const instagramAccounts = options.attemptId
      ? selectNewZernioAccountsForAttempt(listed.accounts, knownIds)
      : listed.accounts;
    // A mesma API key pode expor contas de outros profiles Zernio. Elas não
    // pertencem a esta conexão, não ocupam seus slots e jamais devem aparecer
    // no card ou na decisão de capacidade dela.
    const remoteInstagramAccountCount = listed.accounts.length;

    const rows = instagramAccounts.flatMap((account) => {
      const id = accountId(account);
      if (!id) return [];
      const username = accountUsername(account, id);
      const rowZernioProfileId = accountProfileId(account) ?? zernioProfileIds[0] ?? connection.zernio_profile_id;
      return [{
        organization_id: organizationId,
        instagram_user_id: `zernio:${id}`,
        username,
        display_name: account.displayName ?? username,
        profile_picture_url: accountProfilePicture(account),
        account_type: 'Zernio Instagram',
        capabilities: {
          zernio_content_publish: true,
          zernio_instagram_feed: true,
          zernio_instagram_reels: true,
          zernio_instagram_stories: true,
          zernio_instagram_carousel: true,
        },
        encrypted_access_token: null,
        token_expires_at: null,
        status: (account.isActive === false || account.needsReconnection === true) ? 'offline' : 'online',
        deleted_at: null,
        created_by: userId,
        provider: 'zernio',
        zernio_profile_id: rowZernioProfileId,
        zernio_account_id: id,
        zernio_connection_id: connection.id,
        zernio_account_metadata: account,
      }];
    });

    const checkedAt = new Date().toISOString();
    const connectionHealthUpdate: Record<string, unknown> = {
      status: 'online',
      last_checked_at: checkedAt,
      last_success_at: checkedAt,
      last_sync_at: checkedAt,
      last_error_code: null,
      last_error_message: null,
    };
    Object.assign(connectionHealthUpdate, {
      // O contador mede somente a ocupação do profile remoto desta conexão.
      remote_instagram_account_count: remoteInstagramAccountCount,
      remote_inventory_checked_at: checkedAt,
      remote_inventory_error_code: null,
      remote_inventory_error_message: null,
    });
    await admin
      .from('zernio_connections')
      .update(connectionHealthUpdate)
      .eq('id', connection.id)
      .eq('organization_id', organizationId);

    const billing = await refreshZernioConnectionBilling(organizationId, connection.id).catch(() => null);
    const health = await loadConnectionHealth(client, listed.ids);
    const syncDiagnostic = {
      lockAcquired: locked,
      knownZernioAccountCount: knownIds.length,
      knownZernioAccountIds: knownIds,
      listedZernioAccountCount: listed.ids.length,
      listedZernioAccountIds: listed.ids,
      newZernioAccountIds: listed.newIds,
      health,
      listAttempts: listed.attempts,
      zernioProfileIds,
    };

    if (rows.length === 0) {
      const { error: observationError } = await admin.rpc('record_zernio_connection_inventory_snapshot', {
        p_organization_id: organizationId,
        p_zernio_connection_id: connection.id,
        p_remote_account_ids: listed.ids,
        p_complete_snapshot: true,
      });
      if (observationError) throw observationError;
      if (options.attemptId) {
        const noNewAccountError = new Error('Nenhuma conta remota nova foi encontrada em relação ao baseline do turno. Reconecte somente o perfil faltante.');
        await markZernioConnectionAttemptFailed(options.attemptId, noNewAccountError, syncDiagnostic).catch(() => undefined);
        throw noNewAccountError;
      }
      return { synced: 0, created: 0, updated: 0, unchanged: 0, conflicts: 0, refreshJob: null, billing, health, groupAssignment: null };
    }

    const { data: reconciliation, error } = await admin.rpc('reconcile_zernio_connection_accounts', {
      p_organization_id: organizationId,
      p_zernio_connection_id: connection.id,
      p_rows: rows,
    });

    if (error) {
      await markZernioConnectionAttemptFailed(options.attemptId, error, syncDiagnostic).catch(() => undefined);
      throw error;
    }
    const { error: observationError } = await admin.rpc('record_zernio_connection_inventory_snapshot', {
      p_organization_id: organizationId,
      p_zernio_connection_id: connection.id,
      p_remote_account_ids: listed.ids,
      p_complete_snapshot: true,
    });
    if (observationError) throw observationError;
    const reconciledRows = (reconciliation ?? []) as ZernioReconciliationRow[];
    const successfulRows = reconciledRows.filter((profile) => profile.result_status !== 'conflict');
    const changedRows = successfulRows.filter((profile) => profile.result_status === 'created' || profile.result_status === 'updated');
    const profileIds = successfulRows.map((profile) => profile.profile_id).filter((id): id is string => Boolean(id));
    const changedProfileIds = changedRows.map((profile) => profile.profile_id).filter((id): id is string => Boolean(id));
    const conflicts = reconciledRows.filter((profile) => profile.result_status === 'conflict');
    if (conflicts.length) {
      const conflictProfileIds = conflicts.map((conflict) => conflict.profile_id).filter((id): id is string => Boolean(id));
      const { data: retainedProfiles, error: retainedProfilesError } = conflictProfileIds.length
        ? await admin.from('instagram_profiles').select('id, username, zernio_account_id').in('id', conflictProfileIds)
        : { data: [], error: null };
      if (retainedProfilesError) throw retainedProfilesError;

      const retainedIdByUsername = new Map((retainedProfiles ?? []).map((profile) => [
        String(profile.username).replace(/^@/, '').trim().toLocaleLowerCase('en-US'),
        profile.id,
      ]));
      const retainedIdByAccountId = new Map((retainedProfiles ?? [])
        .filter((profile) => profile.zernio_account_id)
        .map((profile) => [profile.zernio_account_id as string, profile.id]));
      const conflictReasonByProfileId = new Map(conflicts.map((conflict) => [conflict.profile_id, conflict.conflict_reason]));
      const conflictRows = rows.flatMap((row) => {
        const identity = String(row.username).replace(/^@/, '').trim().toLocaleLowerCase('en-US');
        const retainedProfileId = retainedIdByAccountId.get(row.zernio_account_id)
          ?? retainedIdByUsername.get(identity);
        if (!retainedProfileId) return [];
        return [{ row, identity, retainedProfileId, reason: conflictReasonByProfileId.get(retainedProfileId) }];
      });

      await Promise.all(conflictRows.map(async ({ row, identity, retainedProfileId }) => {
        const { error: scheduleError } = await admin.rpc('schedule_zernio_duplicate_identity_disconnection', {
          p_organization_id: organizationId,
          p_zernio_connection_id: connection.id,
          p_zernio_account_id: row.zernio_account_id,
          p_username: row.username,
          p_retained_profile_id: retainedProfileId,
        });
        if (scheduleError && !/entre organizações/i.test(scheduleError.message)) throw scheduleError;
      }));

      const { error: conflictLogError } = await admin.from('zernio_sync_log_items').insert(conflictRows.map(({ row, identity, retainedProfileId, reason }) => ({
        organization_id: organizationId,
        zernio_connection_id: connection.id,
        zernio_account_id: row.zernio_account_id,
        instagram_identity: identity,
        conflict_profile_id: retainedProfileId,
        status: 'conflict',
        error_code: 'instagram_identity_conflict',
        error_message: reason ?? 'A identidade Instagram já está vinculada a outra conexão ou organização.',
      })));
      if (conflictLogError) console.error('Falha ao registrar conflito de sincronia Zernio.', conflictLogError);
    }

    const offlineRows = rows.filter((r) => r.status === 'offline');
    if (offlineRows.length > 0) {
      const profileIdByAccountId = new Map(reconciledRows.map((r, i) => [rows[i]?.zernio_account_id, r.profile_id]));
      await Promise.all(offlineRows.map(async (row) => {
        const profileId = profileIdByAccountId.get(row.zernio_account_id);
        if (!profileId) return;
        const metadata = row.zernio_account_metadata as Record<string, unknown> | undefined;
        const nestedMeta = metadata?.metadata as Record<string, unknown> | undefined;
        const errorMessage = String(
          metadata?.analyticsLastSyncError
          ?? nestedMeta?.publishAuthError
          ?? 'A Zernio informou que a conta está inativa ou desconectada.'
        );
        const { error: scheduleDisconnectError } = await admin.rpc('schedule_zernio_sync_profile_disconnection', {
          p_organization_id: organizationId,
          p_profile_id: profileId,
          p_signal: 'auth_expired',
          p_error_code: 'zernio_account_disconnected',
          p_error_message: errorMessage,
        });
        if (scheduleDisconnectError) {
          console.error('Falha ao agendar reciclagem de perfil offline Zernio.', { profileId, scheduleDisconnectError });
        }
      }));
    }

    // A ordem é intencional: primeiro o perfil é persistido; somente depois o
    // vínculo ao grupo é tentado. Falhas no grupo nunca desfazem o perfil.
    const groupAssignment = await assignAttemptProfilesToRequestedGroup({
      organizationId,
      userId,
      attemptId: options.attemptId,
      profileIds,
    });
    await Promise.all(changedProfileIds.map((profileId) => initializeProfileAnalyticsState(profileId)));
    const refreshJob = await enqueueAnalyticsRefresh(organizationId, changedProfileIds);
    if (options.attemptId) {
      await markZernioConnectionAttemptSynced({
        attemptId: options.attemptId,
        status: 'synced',
        syncAttempts: listed.attempts,
          syncedCount: profileIds.length,
        zernioAccountIds: listed.ids,
        newZernioAccountIds: listed.newIds,
        diagnostic: {
          ...syncDiagnostic,
          reconciledProfileIds: profileIds,
          analyticsProfileIds: changedProfileIds,
          reconciliationCounts: {
            created: reconciledRows.filter((row) => row.result_status === 'created').length,
            updated: reconciledRows.filter((row) => row.result_status === 'updated').length,
            unchanged: reconciledRows.filter((row) => row.result_status === 'unchanged').length,
            conflict: conflicts.length,
          },
        },
      }).catch(() => undefined);
    }
    return {
      synced: profileIds.length,
      created: reconciledRows.filter((row) => row.result_status === 'created').length,
      updated: reconciledRows.filter((row) => row.result_status === 'updated').length,
      unchanged: reconciledRows.filter((row) => row.result_status === 'unchanged').length,
      conflicts: conflicts.length,
      refreshJob,
      billing,
      health,
      groupAssignment,
    };
  }, { leaseSeconds: 30, retries: options.attemptId ? 20 : 8, delayMs: 250 });
}

export async function enqueueZernioOrganizationSync(
  organizationId: string,
  userId: string,
  correlationId = crypto.randomUUID(),
): Promise<ZernioOrganizationSyncEnqueueResult & { correlationId: string }> {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.rpc('enqueue_zernio_organization_sync_batch', {
    p_organization_id: organizationId,
    p_requested_by: userId,
    p_lock_holder: crypto.randomUUID(),
    p_correlation_id: correlationId,
  });
  if (error) throw error;
  const batch = (data ?? [])[0] as { batch_id?: string; total_connections?: number; reused?: boolean; correlation_id?: string } | undefined;
  if (!batch?.batch_id) throw new Error('A sincronia Zernio não retornou um lote válido.');
  return {
    status: batch.reused ? 'already_running' : 'queued',
    batchId: batch.batch_id,
    totalConnections: batch.total_connections ?? 0,
    correlationId: batch.correlation_id ?? correlationId,
  };
}
