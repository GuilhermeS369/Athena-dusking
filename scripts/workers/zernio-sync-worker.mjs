#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import process from 'node:process';
import { createDecipheriv } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

for (const filePath of ['.env.local', '.env.worker']) {
  if (!fs.existsSync(filePath)) continue;
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const separator = rawLine.indexOf('=');
    if (separator <= 0 || rawLine.trim().startsWith('#')) continue;
    const key = rawLine.slice(0, separator).trim();
    if (process.env[key]) continue;
    process.env[key] = rawLine.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
  }
}

const once = process.argv.includes('--once');
const workerId = process.env.ZERNIO_SYNC_WORKER_ID || `athena-vps-zernio-sync-${os.hostname()}-${process.pid}`;
const pollMs = Math.max(1000, Number.parseInt(process.env.ZERNIO_SYNC_WORKER_POLL_INTERVAL_MS || '5000', 10) || 5000);
const heartbeatIntervalMs = Math.max(5000, Number.parseInt(process.env.ZERNIO_SYNC_WORKER_HEARTBEAT_INTERVAL_MS || '30000', 10) || 30000);
// Limita tanto o claim quanto a concorrência efetiva deste processo. Cada item
// continua executando o fluxo completo de sincronização de forma isolada.
const limit = Math.min(20, Math.max(1, Number.parseInt(process.env.ZERNIO_SYNC_WORKER_LIMIT || '10', 10) || 10));
const leaseSeconds = Math.min(900, Math.max(30, Number.parseInt(process.env.ZERNIO_SYNC_WORKER_LEASE_SECONDS || '180', 10) || 180));
const zernioApiBaseUrl = (process.env.ZERNIO_API_BASE_URL || 'https://zernio.com/api').replace(/\/$/, '');
// A propagação após o callback pode atrasar, principalmente quando a proxy do
// aparelho oscila. A recuperação consulta somente o profile isolado já usado
// pelo attempt; ela jamais abre outro OAuth ou cria um novo profile remoto.
const postCallbackRecoverySeconds = Math.min(7200, Math.max(300, Number.parseInt(process.env.ZERNIO_POST_CALLBACK_RECOVERY_SECONDS || '1500', 10) || 1500));

let stopping = false;
let lastHeartbeatAt = 0;

process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

async function heartbeat(status, metadata = {}, lastErrorMessage = null) {
  const { error } = await supabase.rpc('upsert_publication_worker_heartbeat', {
    p_worker_id: workerId,
    p_worker_kind: 'zernio_sync',
    p_status: status,
    p_dry_run: false,
    p_version: process.env.npm_package_version || null,
    p_hostname: os.hostname(),
    p_process_id: process.pid,
    p_last_error_message: lastErrorMessage,
    p_metadata: { once, pollMs, heartbeatIntervalMs, limit, leaseSeconds, ...metadata },
  });
  if (error) throw error;
  lastHeartbeatAt = Date.now();
}

function decryptToken(payload) {
  const [version, ivValue, tagValue, encryptedValue] = payload.split('.');
  if (version !== 'v1' || !ivValue || !tagValue || !encryptedValue) throw new Error('Chave Zernio criptografada inválida.');
  const key = Buffer.from(requiredEnv('TOKEN_ENCRYPTION_KEY'), 'base64');
  if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY inválida.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]).toString('utf8');
}

function accountId(account) {
  return account.accountId ?? account._id ?? account.id ?? null;
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function immutableInstagramId(account) {
  const metadata = objectValue(account?.metadata);
  const metadataProfile = objectValue(metadata.profileData);
  const directProfile = objectValue(account?.profileData);
  return [account?.platformUserId, metadata.platformUserId, metadata.instagramScopedId,
    metadataProfile.instagramScopedId, metadataProfile.id,
    directProfile.instagramScopedId, directProfile.id]
    .map(stringValue).find(Boolean) ?? null;
}

function normalizedUsername(value) {
  return typeof value === 'string' && value.trim()
    ? value.replace(/^@/, '').trim().toLocaleLowerCase('en-US')
    : null;
}

function classifyAttemptAccount(account, baselineAccounts) {
  const id = accountId(account);
  if (!id) return { kind: 'invalid', baseline: null, instagramIdentityId: null };
  const baseline = baselineAccounts.find((candidate) => candidate?.accountId === id) ?? null;
  if (!baseline) return { kind: 'new', baseline: null, instagramIdentityId: immutableInstagramId(account) };
  const currentIdentityId = immutableInstagramId(account);
  if (baseline.instagramIdentityId && currentIdentityId) {
    return baseline.instagramIdentityId === currentIdentityId
      ? { kind: 'existing', baseline, instagramIdentityId: currentIdentityId }
      : { kind: 'reassociated', baseline, instagramIdentityId: currentIdentityId };
  }
  return { kind: 'ambiguous_reuse', baseline, instagramIdentityId: currentIdentityId };
}

function profileId(account) {
  return typeof account.profileId === 'string' ? account.profileId : account.profileId?._id ?? null;
}

function accountsForCanonicalProfile(accounts, canonicalProfileId) {
  if (!canonicalProfileId) return [];
  return accounts
    .filter((account) => account?.platform === 'instagram')
    .filter((account) => profileId(account) === canonicalProfileId);
}

function profilePicture(account) {
  return [account.profilePicture, account.profilePictureUrl, account.profileImageUrl, account.profileImage, account.avatarUrl, account.avatar, account.picture]
    .find((value) => typeof value === 'string' && /^https?:\/\//i.test(value)) ?? null;
}

function safeErrorText(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/(api[_ -]?key|token|authorization)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[REDACTED]')
    .trim();
}

function workerError(caught, stage = 'unknown') {
  const source = caught && typeof caught === 'object' ? caught : {};
  const message = safeErrorText(caught instanceof Error ? caught.message : source.message)
    ?? safeErrorText(typeof caught === 'string' ? caught : null)
    ?? 'Falha sem mensagem retornada pelo provedor.';
  const code = safeErrorText(source.code) ?? (caught instanceof Error ? caught.name : null) ?? 'unknown_error';
  const details = safeErrorText(source.details);
  const hint = safeErrorText(source.hint);
  const summary = [
    `etapa=${stage}`,
    `codigo=${code}`,
    `mensagem=${message}`,
    details ? `detalhes=${details}` : null,
    hint ? `dica=${hint}` : null,
  ].filter(Boolean).join(' | ').slice(0, 1200);

  return { stage, code, message, details, hint, summary };
}

function recoveryDelaySeconds(observationCount) {
  const sequence = [5, 10, 20, 40, 60, 90, 120, 180];
  return sequence[Math.min(Math.max(0, observationCount - 1), sequence.length - 1)];
}

function recoveryDeadlineReached(attempt, nowMs = Date.now()) {
  const deadlineMs = Date.parse(String(attempt.recovery_deadline_at ?? ''));
  return Number.isFinite(deadlineMs) && deadlineMs <= nowMs;
}

const supabase = createClient(requiredEnv('NEXT_PUBLIC_SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function schedulePostCallbackRecovery(attempt, reason, diagnosticPatch = {}) {
  const now = new Date();
  const recoveryStartedAt = attempt.recovery_started_at ?? now.toISOString();
  const recoveryDeadlineAt = attempt.recovery_deadline_at
    ?? new Date(now.getTime() + postCallbackRecoverySeconds * 1000).toISOString();
  const observationCount = Number(attempt.recovery_observation_count ?? 0) + 1;
  const nextAttemptAt = new Date(now.getTime() + recoveryDelaySeconds(observationCount) * 1000).toISOString();
  const { error } = await supabase.from('zernio_connection_attempts').update({
    worker_status: 'pending', worker_id: null, worker_lease_expires_at: null,
    recovery_started_at: recoveryStartedAt,
    recovery_deadline_at: recoveryDeadlineAt,
    recovery_next_attempt_at: nextAttemptAt,
    recovery_observation_count: observationCount,
    recovery_last_reason: reason,
    worker_error_code: null,
    worker_error_stage: null,
    last_error_message: null,
    diagnostic: {
      ...attempt.diagnostic,
      lastWorkerObservationAt: now.toISOString(),
      lastWorkerObservation: reason,
      recoveryNextAttemptAt: nextAttemptAt,
      recoveryDeadlineAt,
      recoveryObservationCount: observationCount,
      ...diagnosticPatch,
    },
  }).eq('id', attempt.id);
  if (error) throw error;
  return { recoveryDeadlineAt, nextAttemptAt, observationCount };
}

function isTransientZernioInventoryFailure(error) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /Zernio HTTP (408|425|429|5\d\d)|TimeoutError|timed out|fetch failed|network/i.test(message);
}

async function syncClaimedItem(item) {
  let stage = 'load_connection';
  try {
  const { data: connection, error: connectionError } = await supabase
    .from('zernio_connections')
    .select('id, zernio_profile_id, encrypted_api_key')
    .eq('id', item.zernio_connection_id)
    .eq('organization_id', item.organization_id)
    .is('deleted_at', null)
    .maybeSingle();
  if (connectionError) throw connectionError;
  if (!connection) throw new Error('Conexão Zernio ativa não encontrada.');
  stage = 'fetch_remote_accounts';
  const response = await fetch(`${zernioApiBaseUrl}/v1/accounts`, {
    headers: { Authorization: `Bearer ${decryptToken(connection.encrypted_api_key)}` },
    cache: 'no-store', signal: AbortSignal.timeout(25_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Zernio HTTP ${response.status}: ${String(payload.message ?? payload.error ?? 'sem detalhe')}`);
  const remoteAccounts = Array.isArray(payload.accounts) ? payload.accounts : [];
  const rows = accountsForCanonicalProfile(remoteAccounts, connection.zernio_profile_id)
    .flatMap((account) => {
      const id = accountId(account);
      if (!id) return [];
      const username = typeof account.username === 'string' && account.username.trim()
        ? account.username.replace(/^@/, '').trim()
        : id;
      return [{
        organization_id: item.organization_id,
        instagram_user_id: `zernio:${id}`,
        username,
        display_name: account.displayName ?? username,
        profile_picture_url: profilePicture(account),
        account_type: 'Zernio Instagram',
        capabilities: {
          zernio_content_publish: true, zernio_instagram_feed: true,
          zernio_instagram_reels: true, zernio_instagram_stories: true, zernio_instagram_carousel: true,
        },
        status: (account.isActive === false || account.needsReconnection === true) ? 'offline' : 'online',
        created_by: item.requested_by,
        provider: 'zernio',
        // Nunca aceite um profileId inferido ou pertencente a outra conexão.
        // accountsForCanonicalProfile já provou o vínculo remoto canônico.
        zernio_profile_id: connection.zernio_profile_id,
        zernio_account_id: id,
        zernio_connection_id: connection.id,
        zernio_account_metadata: account,
      }];
    });
   // A API key pode listar contas de profiles externos. A ocupação desta
   // conexão é exclusivamente a do seu profile remoto canônico.
   const remoteInstagramAccountCount = accountsForCanonicalProfile(remoteAccounts, connection.zernio_profile_id).length;
  stage = 'reconcile_accounts';
  const { data: reconciliation, error: reconciliationError } = await supabase.rpc('reconcile_zernio_connection_accounts', {
    p_organization_id: item.organization_id,
    p_zernio_connection_id: connection.id,
    p_rows: rows,
  });
  if (reconciliationError) throw reconciliationError;
  stage = 'record_inventory_observations';
  const { error: observationError } = await supabase.rpc('record_zernio_connection_inventory_snapshot', {
    p_organization_id: item.organization_id,
    p_zernio_connection_id: connection.id,
    p_remote_account_ids: rows.map((row) => row.zernio_account_id).filter(Boolean),
    p_complete_snapshot: true,
  });
  if (observationError) throw observationError;
  const resultRows = reconciliation ?? [];
  const conflicts = resultRows.filter((row) => row.result_status === 'conflict');
  const successfulRows = resultRows.filter((row) => row.result_status !== 'conflict');
  const changedRows = successfulRows.filter((row) => row.result_status === 'created' || row.result_status === 'updated');
  const changedProfileIds = changedRows.map((row) => row.profile_id).filter(Boolean);
  const synced = successfulRows.length;
  const reconciliationCounts = {
    created: resultRows.filter((row) => row.result_status === 'created').length,
    updated: resultRows.filter((row) => row.result_status === 'updated').length,
    unchanged: resultRows.filter((row) => row.result_status === 'unchanged').length,
    conflict: conflicts.length,
  };
  let refreshJob = null;
  if (changedProfileIds.length) {
    stage = 'enqueue_selective_analytics';
    const { data: refreshJobs, error: refreshJobError } = await supabase.rpc('enqueue_zernio_reconciliation_analytics', {
      p_organization_id: item.organization_id,
      p_profile_ids: changedProfileIds,
    });
    if (refreshJobError) throw refreshJobError;
    refreshJob = refreshJobs?.[0] ?? null;
  }
  const duplicateRemovals = [];

  // A RPC pode devolver linhas sem ordem garantida. Relacionamos o conflito ao
  // perfil canônico pelo username, em vez de depender da posição no resultado.
  const conflictProfileIds = conflicts.map((result) => result.profile_id).filter(Boolean);
  stage = 'load_retained_profiles';
  const { data: retainedProfiles, error: retainedProfilesError } = conflictProfileIds.length
    ? await supabase.from('instagram_profiles').select('id, username, zernio_account_id').in('id', conflictProfileIds)
    : { data: [], error: null };
  if (retainedProfilesError) throw retainedProfilesError;
  const retainedIdByUsername = new Map((retainedProfiles ?? []).map((profile) => [
    String(profile.username).replace(/^@/, '').trim().toLocaleLowerCase('en-US'),
    profile.id,
  ]));
  const retainedIdByAccountId = new Map((retainedProfiles ?? [])
    .filter((profile) => profile.zernio_account_id)
    .map((profile) => [profile.zernio_account_id, profile.id]));

  // Só conflitos dentro da própria organização podem virar remoção automática;
  // a RPC de agendamento bloqueia entre organizações e preserva a canônica.
  stage = 'schedule_duplicate_disconnections';
  for (const row of rows) {
    const retainedProfileId = retainedIdByAccountId.get(row.zernio_account_id)
      ?? retainedIdByUsername.get(String(row.username).replace(/^@/, '').trim().toLocaleLowerCase('en-US'));
    if (!row.zernio_account_id || !row.username || !retainedProfileId) continue;
    const { data: scheduled, error: scheduleError } = await supabase.rpc('schedule_zernio_duplicate_identity_disconnection', {
      p_organization_id: item.organization_id,
      p_zernio_connection_id: connection.id,
      p_zernio_account_id: row.zernio_account_id,
      p_username: row.username,
      p_retained_profile_id: retainedProfileId,
    });
    if (scheduleError) {
      duplicateRemovals.push({ accountId: row.zernio_account_id, state: 'blocked', reason: scheduleError.message });
      continue;
    }
    duplicateRemovals.push({ accountId: row.zernio_account_id, state: scheduled?.scheduled ? 'scheduled' : 'deferred', reason: scheduled?.reason ?? null });
  }
  const checkedAt = new Date().toISOString();
  stage = 'update_connection_health';
  const { error: connectionUpdateError } = await supabase.from('zernio_connections').update({
    status: 'online', last_checked_at: checkedAt, last_success_at: checkedAt,
    last_sync_at: checkedAt, last_error_code: null, last_error_message: null,
    remote_instagram_account_count: remoteInstagramAccountCount,
    remote_inventory_checked_at: checkedAt,
    remote_inventory_error_code: null,
    remote_inventory_error_message: null,
  }).eq('id', connection.id).eq('organization_id', item.organization_id);
  if (connectionUpdateError) throw connectionUpdateError;
  stage = 'write_conflict_logs';
    if (conflicts.length) {
    const conflictReasonByProfileId = new Map(conflicts.map((conflict) => [conflict.profile_id, conflict.conflict_reason]));
    const conflictLogRows = rows.flatMap((row) => {
      const identity = String(row.username).replace(/^@/, '').trim().toLocaleLowerCase('en-US');
      const retainedProfileId = retainedIdByAccountId.get(row.zernio_account_id)
        ?? retainedIdByUsername.get(identity);
      if (!retainedProfileId) return [];
      return [{
        organization_id: item.organization_id,
        batch_id: item.batch_id,
        zernio_connection_id: connection.id,
        zernio_account_id: row.zernio_account_id,
        instagram_identity: identity,
        conflict_profile_id: retainedProfileId,
        status: 'conflict',
        error_code: 'instagram_identity_conflict',
        error_message: conflictReasonByProfileId.get(retainedProfileId) ?? 'A identidade Instagram já está vinculada a outra conexão ou organização.',
      }];
    });
    const { error: conflictLogError } = await supabase.from('zernio_sync_log_items').insert(conflictLogRows);
    if (conflictLogError) throw conflictLogError;
  }

  const offlineRows = rows.filter((r) => r.status === 'offline');
  if (offlineRows.length > 0) {
    const profileIdByAccountId = new Map(resultRows.map((r, i) => [rows[i]?.zernio_account_id, r.profile_id]));
    for (const row of offlineRows) {
      const profileId = profileIdByAccountId.get(row.zernio_account_id);
      if (!profileId) continue;
      const metadata = row.zernio_account_metadata || {};
      const nestedMeta = metadata.metadata || {};
      const errorMessage = String(
        metadata.analyticsLastSyncError
        || nestedMeta.publishAuthError
        || 'A Zernio informou que a conta está inativa ou desconectada.'
      );
      const { error: scheduleDisconnectError } = await supabase.rpc('schedule_zernio_sync_profile_disconnection', {
        p_organization_id: item.organization_id,
        p_profile_id: profileId,
        p_signal: 'auth_expired',
        p_error_code: 'zernio_account_disconnected',
        p_error_message: errorMessage,
      });
      if (scheduleDisconnectError) {
        console.error('[zernio-sync-worker] falha ao agendar reciclagem de perfil offline Zernio', { profileId, scheduleDisconnectError });
      }
    }
  }

  return { synced, conflicts: conflicts.length, reconciliationCounts, refreshJob, duplicateRemovals };
  } catch (caught) {
    throw workerError(caught, stage);
  }
}

async function processConnectionAddition(item) {
  let stage = 'load_attempt';
  let reservationId = null;
  let attempt = null;
  try {
    const { data: loadedAttempt, error: attemptError } = await supabase.from('zernio_connection_attempts')
      .select('id, organization_id, zernio_connection_id, created_by, zernio_profile_id, zernio_connection_intent_id, zernio_slot_reservation_id, requested_group_id, diagnostic, worker_attempt_count, recovery_started_at, recovery_deadline_at, recovery_observation_count')
      .eq('id', item.attempt_id).single();
    if (attemptError) throw attemptError;
    attempt = loadedAttempt;

    stage = 'load_connection';
    const { data: connection, error: connectionError } = await supabase.from('zernio_connections')
      .select('id, zernio_profile_id, encrypted_api_key').eq('id', attempt.zernio_connection_id)
      .eq('organization_id', attempt.organization_id).is('deleted_at', null).single();
    if (connectionError) throw connectionError;
    if (!attempt.zernio_profile_id) throw new Error('A tentativa não possui profile remoto isolado. Nenhuma conta foi atribuída.');
    const { data: remoteProfile, error: remoteProfileError } = await supabase
      .from('zernio_connection_remote_profiles')
      .select('id, status, claimed_by_attempt_id')
      .eq('organization_id', attempt.organization_id)
      .eq('zernio_connection_id', connection.id)
      .eq('zernio_profile_id', attempt.zernio_profile_id)
      .maybeSingle();
    if (remoteProfileError) throw remoteProfileError;
    if (!remoteProfile || !['claimed', 'connected'].includes(remoteProfile.status)
      || (remoteProfile.status === 'claimed' && remoteProfile.claimed_by_attempt_id !== attempt.id)) {
      throw new Error('O profile remoto da tentativa não pertence exclusivamente a esta conexão e a este aparelho.');
    }

    stage = 'fetch_remote_accounts';
    const response = await fetch(`${zernioApiBaseUrl}/v1/accounts`, {
      headers: { Authorization: `Bearer ${decryptToken(connection.encrypted_api_key)}` },
      cache: 'no-store', signal: AbortSignal.timeout(25_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Zernio HTTP ${response.status}: ${String(payload.message ?? payload.error ?? 'sem detalhe')}`);

    const knownIds = new Set(Array.isArray(attempt.diagnostic?.knownZernioAccountIds) ? attempt.diagnostic.knownZernioAccountIds : []);
    const baselineAccounts = Array.isArray(attempt.diagnostic?.knownZernioAccounts)
      ? attempt.diagnostic.knownZernioAccounts : [];
    const allAccounts = accountsForCanonicalProfile(
      Array.isArray(payload.accounts) ? payload.accounts : [],
      attempt.zernio_profile_id,
    );
    const unseenAccounts = allAccounts.filter((account) => {
      const id = accountId(account);
      return id && !knownIds.has(id);
    });
    const explicitAccountId = typeof attempt.diagnostic?.explicitCallbackAccountId === 'string'
      ? attempt.diagnostic.explicitCallbackAccountId.trim()
      : '';
    const observedCandidates = explicitAccountId
      ? allAccounts.filter((account) => accountId(account) === explicitAccountId)
      : allAccounts;
    const classifiedCandidates = observedCandidates.map((account) => ({
      account,
      classification: classifyAttemptAccount(account, baselineAccounts),
    }));
    const candidateAccounts = classifiedCandidates
      .filter(({ classification }) => ['new', 'reassociated'].includes(classification.kind))
      .map(({ account }) => account);

    const existingCallbackAccount = classifiedCandidates.find(({ classification }) => classification.kind === 'existing');
    if (explicitAccountId && existingCallbackAccount) {
      throw new Error('A autorização retornou a mesma conta Instagram já existente. Ela não foi aceita como uma conta nova.');
    }
    const ambiguousReuse = classifiedCandidates.find(({ classification }) => classification.kind === 'ambiguous_reuse');
    if (explicitAccountId && ambiguousReuse) {
      throw new Error('A Zernio reutilizou um accountId, mas não forneceu identidade imutável suficiente para comprovar a reassociação. Nenhuma conta foi atribuída.');
    }

    if (explicitAccountId && !observedCandidates.length) {
      const superseded = new Error('A conta indicada pelo callback não pertence mais ao inventário canônico. A autorização remota foi substituída antes da finalização.');
      superseded.code = 'remote_authorization_superseded';
      throw superseded;
    }

    // Callback recebido não prova que o inventário já propagou a conta. A
    // recuperação dura até o prazo seguro; não depende do contador geral do
    // worker e não libera o profile isolado enquanto houver incerteza.
    if (!candidateAccounts.length && !recoveryDeadlineReached(attempt)) {
      const recovery = await schedulePostCallbackRecovery(attempt, 'remote_account_not_visible_yet');
      await supabase.rpc('release_zernio_addition_organization_lock', { p_attempt_id: attempt.id, p_worker_id: workerId });
      return { status: 'recovering', attemptId: attempt.id, ...recovery };
    }
    if (!candidateAccounts.length) {
      if (recoveryDeadlineReached(attempt)) {
        const now = new Date().toISOString();
        await supabase.from('zernio_connection_attempts').update({
          worker_status: 'recovery_paused', worker_id: null, worker_lease_expires_at: null,
          worker_completed_at: now, recovery_paused_at: now,
          recovery_next_attempt_at: null,
          recovery_last_reason: 'remote_account_not_visible_before_deadline',
          worker_error_code: 'zernio_recovery_deadline_reached',
          worker_error_stage: stage,
          last_error_message: 'A autorização foi recebida, mas a Zernio não apresentou a conta dentro do prazo de recuperação. Retome a confirmação para consultar novamente sem abrir outro OAuth.',
          diagnostic: { ...attempt.diagnostic, recoveryPausedAt: now, recoveryPauseReason: 'remote_account_not_visible_before_deadline' },
        }).eq('id', attempt.id);
        await supabase.rpc('release_zernio_addition_organization_lock', { p_attempt_id: attempt.id, p_worker_id: workerId });
        return { status: 'recovery_paused', attemptId: attempt.id };
      }
      if (ambiguousReuse) {
        throw new Error('A Zernio reutilizou um accountId, mas não forneceu identidade imutável suficiente para comprovar a reassociação. Nenhuma conta foi atribuída.');
      }
      if (existingCallbackAccount) {
        throw new Error('A autorização manteve somente contas Instagram já existentes. Nenhuma delas foi aceita como nova.');
      }
      throw new Error('A Zernio não apresentou uma conta nova após o callback. O baseline foi preservado e nenhuma duplicata foi criada.');
    }

    stage = 'claim_callback_account';
    let selectedAccount = null;
    for (const candidateAccount of candidateAccounts) {
      const candidateAccountId = accountId(candidateAccount);
      const candidateClassification = classifyAttemptAccount(candidateAccount, baselineAccounts);
      const { data: accountClaimed, error: accountClaimError } = await supabase.rpc('claim_zernio_addition_account', {
        p_attempt_id: attempt.id,
        p_worker_id: workerId,
        p_zernio_account_id: candidateAccountId,
        p_source: explicitAccountId ? 'callback' : 'fifo_fallback',
      });
      if (accountClaimError) throw accountClaimError;
      if (accountClaimed) {
        selectedAccount = candidateAccount;
        break;
      }
    }
    if (!selectedAccount) throw new Error('As contas novas visíveis já pertencem a outras solicitações. Nenhuma atribuição duplicada foi feita.');
    const newAccounts = [selectedAccount];
    const selectedClassification = classifyAttemptAccount(selectedAccount, baselineAccounts);

    // A conta já existe remotamente a partir deste ponto. Marcar o profile como
    // conectado antes da persistência impede que qualquer falha ou conflito
    // posterior devolva um profile ocupado ao pool de novos OAuths.
    stage = 'mark_remote_profile_authorized';
    const { data: remoteProfileMarked, error: remoteProfileMarkError } = await supabase.rpc(
      'mark_zernio_attempt_remote_profile_connected',
      { p_attempt_id: attempt.id },
    );
    if (remoteProfileMarkError) throw remoteProfileMarkError;
    if (!remoteProfileMarked) {
      throw new Error('O profile remoto autorizado não pôde ser marcado como ocupado. A finalização foi interrompida com segurança.');
    }

    // A RPC desconta a própria linha ativa quando a reassociação atualiza o
    // vínculo do accountId; uma conta realmente nova continua consumindo slot.
    stage = 'reserve_finalization_slot';
    const { data: reservationRows, error: reservationError } = await supabase.rpc('reserve_zernio_addition_finalization_slot', {
      p_attempt_id: attempt.id,
      p_worker_id: workerId,
      p_lease_seconds: Math.max(300, leaseSeconds),
    });
    if (reservationError) throw reservationError;
    const reservation = reservationRows?.[0];
    if (!reservation?.reservation_id || reservation.zernio_connection_id !== attempt.zernio_connection_id) {
      throw new Error('A reserva final não corresponde à conexão que recebeu a autorização OAuth.');
    }
    reservationId = reservation.reservation_id;

    const rows = newAccounts.flatMap((account) => {
      const id = accountId(account);
      if (!id) return [];
      const username = typeof account.username === 'string' && account.username.trim() ? account.username.replace(/^@/, '').trim() : id;
      return [{
        organization_id: attempt.organization_id, instagram_user_id: `zernio:${id}`, username,
        display_name: account.displayName ?? username, profile_picture_url: profilePicture(account),
        account_type: 'Zernio Instagram', capabilities: {
          zernio_content_publish: true, zernio_instagram_feed: true, zernio_instagram_reels: true,
          zernio_instagram_stories: true, zernio_instagram_carousel: true,
        }, status: (account.isActive === false || account.needsReconnection === true) ? 'offline' : 'online',
        created_by: attempt.created_by, provider: 'zernio', zernio_profile_id: attempt.zernio_profile_id,
        zernio_account_id: id, zernio_connection_id: connection.id, zernio_account_metadata: account,
        zernio_identity_resolution: selectedClassification.kind,
        instagram_identity_id: selectedClassification.instagramIdentityId,
      }];
    });

    stage = 'reconcile_accounts';
    const { data: reconciliation, error: reconciliationError } = await supabase.rpc('reconcile_zernio_connection_accounts', {
      p_organization_id: attempt.organization_id, p_zernio_connection_id: connection.id, p_rows: rows,
    });
    if (reconciliationError) throw reconciliationError;
    const results = reconciliation ?? [];
    const conflicts = results.filter((row) => row.result_status === 'conflict');
    const successes = results.filter((row) => row.result_status !== 'conflict');
    const resultDetails = rows.map((row, index) => ({
      zernioAccountId: row.zernio_account_id, username: row.username,
      profileId: results[index]?.profile_id ?? null, status: results[index]?.result_status ?? 'unknown',
      reason: results[index]?.conflict_reason ?? null,
    }));

    stage = 'assign_requested_group';
    let groupAssignment = { assignment_status: 'not_requested', assigned_profile_ids: [], error_message: null };
    if (successes.length) {
      const successfulProfileIds = successes.map((row) => row.profile_id).filter(Boolean);
      const { data: assignmentRows, error: assignmentError } = await supabase.rpc('assign_zernio_attempt_profiles_to_group', {
        p_organization_id: attempt.organization_id,
        p_attempt_id: attempt.id,
        p_profile_ids: successfulProfileIds,
        p_added_by: attempt.created_by,
      });
      if (assignmentError) throw assignmentError;
      groupAssignment = assignmentRows?.[0] ?? groupAssignment;
      if (attempt.requested_group_id && groupAssignment.assignment_status !== 'assigned') {
        throw new Error(groupAssignment.error_message ?? 'A conta foi reconciliada, mas não pôde ser associada ao grupo solicitado.');
      }
    }

    stage = 'schedule_duplicate_disconnections';
    const duplicateDisconnections = [];
    const conflictProfileIds = resultDetails.filter((candidate) => candidate.status === 'conflict' && candidate.profileId).map((candidate) => candidate.profileId);
    const { data: retainedProfiles } = conflictProfileIds.length
      ? await supabase.from('instagram_profiles').select('id, organization_id, username').in('id', conflictProfileIds).is('deleted_at', null)
      : { data: [] };
    const retainedById = new Map((retainedProfiles ?? []).map((profile) => [profile.id, profile]));
    for (const detail of resultDetails.filter((candidate) => candidate.status === 'conflict' && candidate.profileId)) {
      const retained = retainedById.get(detail.profileId);
      if (!retained) {
        duplicateDisconnections.push({ accountId: detail.zernioAccountId, state: 'blocked', reason: 'canonical_profile_missing' });
        continue;
      }
      if (retained.organization_id !== attempt.organization_id) {
        duplicateDisconnections.push({ accountId: detail.zernioAccountId, state: 'blocked', reason: 'cross_organization' });
        continue;
      }
      const { error: scheduleError } = await supabase.rpc('schedule_zernio_duplicate_identity_disconnection', {
        p_organization_id: attempt.organization_id,
        p_zernio_connection_id: connection.id,
        p_zernio_account_id: detail.zernioAccountId,
        p_username: detail.username,
        p_retained_profile_id: detail.profileId,
      });
      // Entre empresas a remoção é deliberadamente bloqueada, mas o conflito
      // continua registrado e visível no histórico da solicitação.
      if (scheduleError) {
        duplicateDisconnections.push({ accountId: detail.zernioAccountId, state: 'blocked', reason: scheduleError.message });
        continue;
      }
      duplicateDisconnections.push({ accountId: detail.zernioAccountId, state: 'scheduled', reason: null });
    }

    stage = 'record_result';
    const terminalStatus = successes.length ? 'synced' : conflicts.length ? 'failed' : 'empty';
    const workerStatus = conflicts.length ? 'conflict' : 'completed';
    const now = new Date().toISOString();
    const diagnostic = { ...attempt.diagnostic, additionResults: resultDetails, duplicateDisconnections, groupAssignment,
      accountSelection: {
        accountId: accountId(selectedAccount),
        classification: selectedClassification.kind,
        instagramIdentityId: selectedClassification.instagramIdentityId,
        previousUsername: selectedClassification.baseline?.username ?? null,
        currentUsername: normalizedUsername(selectedAccount.username),
      }, reconciliationCounts: {
      created: results.filter((row) => row.result_status === 'created').length,
      updated: results.filter((row) => row.result_status === 'updated').length,
      unchanged: results.filter((row) => row.result_status === 'unchanged').length,
      conflict: conflicts.length,
    }};
    const { error: updateError } = await supabase.from('zernio_connection_attempts').update({
      status: terminalStatus, worker_status: workerStatus, worker_id: workerId,
      worker_lease_expires_at: null, worker_completed_at: now, synced_at: successes.length ? now : null,
      failed_at: conflicts.length && !successes.length ? now : null, synced_count: successes.length,
      zernio_account_ids: rows.map((row) => row.zernio_account_id),
      new_zernio_account_ids: rows.map((row) => row.zernio_account_id), diagnostic,
      last_error_message: conflicts.length ? conflicts.map((row) => row.conflict_reason).filter(Boolean).join(' | ').slice(0, 1000) : null,
    }).eq('id', attempt.id);
    if (updateError) throw updateError;

    if (attempt.zernio_connection_intent_id) await supabase.from('zernio_connection_intents').update({
      status: terminalStatus, diagnostic: { ...diagnostic, completedByWorkerAt: now },
    }).eq('id', attempt.zernio_connection_intent_id);
    if (successes.length) {
      const { error: profileConnectedError } = await supabase.rpc('mark_zernio_attempt_remote_profile_connected', {
        p_attempt_id: attempt.id,
      });
      if (profileConnectedError) throw profileConnectedError;
    } else {
      const { error: profileReleaseError } = await supabase.rpc('release_zernio_attempt_remote_profile', {
      p_attempt_id: attempt.id,
      p_reason: conflicts.length ? 'worker_conflict' : 'worker_empty',
      });
      if (profileReleaseError) throw profileReleaseError;
    }
    if (reservationId ?? attempt.zernio_slot_reservation_id) await supabase.from('zernio_connection_slot_reservations').update({
      released_at: now, release_reason: conflicts.length ? 'worker_conflict' : 'worker_completed',
    }).eq('id', reservationId ?? attempt.zernio_slot_reservation_id).is('released_at', null);

    if (conflicts.length) {
      await supabase.from('zernio_sync_log_items').insert(resultDetails.filter((detail) => detail.status === 'conflict').map((detail) => ({
        organization_id: attempt.organization_id, zernio_connection_id: connection.id,
        zernio_account_id: detail.zernioAccountId, instagram_identity: detail.username.toLocaleLowerCase('en-US'),
        conflict_profile_id: detail.profileId, status: 'conflict', error_code: 'instagram_identity_conflict',
        error_message: detail.reason ?? 'Identidade Instagram em conflito.',
      })));
    }
    const turnId = typeof attempt.diagnostic?.oauthTurnId === 'string' ? attempt.diagnostic.oauthTurnId : null;
    if (turnId) await supabase.rpc('finish_zernio_oauth_turn', {
      p_organization_id: attempt.organization_id, p_turn_id: turnId,
      p_attempt_id: attempt.id, p_created_by: attempt.created_by,
      p_terminal_status: conflicts.length ? 'failed' : 'completed',
      p_reason: conflicts.length ? 'worker_conflict' : 'worker_completed',
    });
    await supabase.rpc('release_zernio_addition_organization_lock', { p_attempt_id: attempt.id, p_worker_id: workerId });
    return { status: workerStatus, attemptId: attempt.id, successes: successes.length, conflicts: conflicts.length };
  } catch (caught) {
    if (attempt && stage === 'fetch_remote_accounts'
      && !recoveryDeadlineReached(attempt)
      && isTransientZernioInventoryFailure(caught)) {
      const recovery = await schedulePostCallbackRecovery(attempt, 'transient_zernio_inventory_failure', {
        lastTransientInventoryError: workerError(caught, stage).summary,
      });
      await supabase.rpc('release_zernio_addition_organization_lock', { p_attempt_id: attempt.id, p_worker_id: workerId });
      return { status: 'recovering', attemptId: attempt.id, ...recovery };
    }
    const diagnostic = workerError(caught, stage);
    const now = new Date().toISOString();
    await supabase.from('zernio_connection_attempts').update({
      status: 'failed', worker_status: 'failed', worker_lease_expires_at: null, worker_completed_at: now,
      failed_at: now, worker_error_code: diagnostic.code.slice(0, 120), worker_error_stage: stage,
      last_error_message: diagnostic.summary,
    }).eq('id', item.attempt_id);
    if (reservationId) await supabase.from('zernio_connection_slot_reservations').update({
      released_at: now, release_reason: 'worker_failed',
    }).eq('id', reservationId).is('released_at', null);
    const { data: failedAttempt } = await supabase.from('zernio_connection_attempts')
      .select('organization_id, created_by, diagnostic').eq('id', item.attempt_id).maybeSingle();
    const { error: failedProfileReleaseError } = await supabase.rpc('release_zernio_attempt_remote_profile', {
      p_attempt_id: item.attempt_id,
      p_reason: `worker_${stage}`.slice(0, 120),
    });
    if (failedProfileReleaseError) console.error('[zernio-sync-worker] falha ao liberar profile remoto isolado', failedProfileReleaseError);
    const failedTurnId = typeof failedAttempt?.diagnostic?.oauthTurnId === 'string' ? failedAttempt.diagnostic.oauthTurnId : null;
    if (failedTurnId) await supabase.rpc('finish_zernio_oauth_turn', {
      p_organization_id: failedAttempt.organization_id, p_turn_id: failedTurnId,
      p_attempt_id: item.attempt_id, p_created_by: failedAttempt.created_by,
      p_terminal_status: 'failed', p_reason: `worker_${stage}`.slice(0, 120),
    });
    await supabase.rpc('release_zernio_addition_organization_lock', { p_attempt_id: item.attempt_id, p_worker_id: workerId });
    throw diagnostic;
  }
}

async function tick() {
  const { data: additions, error: additionsError } = await supabase.rpc('claim_zernio_connection_additions', {
    p_worker_id: workerId, p_limit: limit, p_lease_seconds: leaseSeconds,
  });
  if (additionsError) throw additionsError;
  const additionResults = [];
  for (const addition of additions ?? []) {
    try { additionResults.push(await processConnectionAddition(addition)); }
    catch (error) { additionResults.push({ attemptId: addition.attempt_id, status: 'failed', error: error?.summary ?? String(error) }); }
  }
  const { data: claimed, error } = await supabase.rpc('claim_zernio_sync_batch_items', {
    p_worker_id: workerId, p_limit: limit, p_lease_seconds: leaseSeconds,
  });
  if (error) throw error;
  const batchIds = [...new Set((claimed ?? []).map((item) => item.batch_id))];
  const { data: batches, error: batchesError } = batchIds.length
    ? await supabase.from('zernio_sync_batches').select('id, correlation_id').in('id', batchIds)
    : { data: [], error: null };
  if (batchesError) throw batchesError;
  const correlationByBatchId = new Map((batches ?? []).map((batch) => [batch.id, batch.correlation_id]));
  const results = await Promise.all((claimed ?? []).map(async (item) => {
    try {
      const result = await syncClaimedItem(item);
      const { error: completeError } = await supabase.rpc('complete_zernio_sync_batch_item', {
        p_item_id: item.item_id, p_worker_id: workerId, p_synced_count: result.synced,
        p_conflict_count: result.conflicts, p_error_message: null,
      });
      if (completeError) throw completeError;
      const { error: successLogError } = await supabase.from('zernio_sync_log_items').insert({
        organization_id: item.organization_id, batch_id: item.batch_id, zernio_connection_id: item.zernio_connection_id,
        status: 'succeeded', synced_count: result.synced,
      });
      if (successLogError) {
        const diagnostic = workerError(successLogError, 'write_success_log');
        console.error('[zernio-sync-worker] falha ao registrar sucesso', {
          correlationId: correlationByBatchId.get(item.batch_id) ?? null,
          batchId: item.batch_id,
          itemId: item.item_id,
          connectionId: item.zernio_connection_id,
          ...diagnostic,
          summary: undefined,
        });
      }
      return { itemId: item.item_id, correlationId: correlationByBatchId.get(item.batch_id) ?? null, status: 'completed', ...result };
    } catch (caught) {
      const diagnostic = caught && typeof caught === 'object' && typeof caught.summary === 'string'
        ? caught
        : workerError(caught, 'complete_or_log_item');
      const message = diagnostic.summary;
      console.error('[zernio-sync-worker] item falhou', {
        correlationId: correlationByBatchId.get(item.batch_id) ?? null,
        batchId: item.batch_id,
        itemId: item.item_id,
        connectionId: item.zernio_connection_id,
        attemptCount: item.attempt_count,
        stage: diagnostic.stage,
        code: diagnostic.code,
        message: diagnostic.message,
        details: diagnostic.details,
        hint: diagnostic.hint,
      });
      const { data: completion, error: completionError } = await supabase.rpc('complete_zernio_sync_batch_item', {
        p_item_id: item.item_id, p_worker_id: workerId, p_synced_count: 0, p_conflict_count: 0, p_error_message: message,
      });
      if (completionError) throw completionError;
      const { error: failureLogError } = await supabase.from('zernio_sync_log_items').insert({
        organization_id: item.organization_id, batch_id: item.batch_id, zernio_connection_id: item.zernio_connection_id,
        status: 'failed', error_code: diagnostic.code.slice(0, 120), error_message: message,
      });
      if (failureLogError) console.error('[zernio-sync-worker] falha ao registrar erro', workerError(failureLogError, 'write_failure_log'));
      return {
        itemId: item.item_id,
        correlationId: correlationByBatchId.get(item.batch_id) ?? null,
        status: completion?.completed === false ? 'retrying' : 'failed',
        stage: diagnostic.stage,
        code: diagnostic.code,
      };
    }
  }));
  const summary = {
    additions: (additions ?? []).length,
    additionResults,
    claimed: (claimed ?? []).length,
    results,
  };
  console.info('[zernio-sync-worker] ciclo', summary);
  return summary;
}

async function main() {
  console.info('[zernio-sync-worker] iniciando', { workerId, once, pollMs, heartbeatIntervalMs, limit, leaseSeconds });
  await heartbeat('starting');

  while (!stopping) {
    try {
      const summary = await tick();
      const status = summary.additions > 0 || summary.claimed > 0 ? 'processing' : 'idle';
      if (Date.now() - lastHeartbeatAt >= heartbeatIntervalMs) await heartbeat(status, { summary });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[zernio-sync-worker] falha no ciclo', error);
      await heartbeat('error', {}, message).catch((heartbeatError) => {
        console.error('[zernio-sync-worker] falha ao registrar heartbeat de erro', heartbeatError);
      });
    }

    if (once) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  await heartbeat('stopped').catch((error) => console.error('[zernio-sync-worker] falha ao registrar parada', error));
  console.info('[zernio-sync-worker] finalizado', { workerId });
}

main().catch((error) => {
  console.error('[zernio-sync-worker] erro fatal', error);
  process.exitCode = 1;
});
