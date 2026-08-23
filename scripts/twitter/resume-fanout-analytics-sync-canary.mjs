#!/usr/bin/env node
import { createDecipheriv, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createClient } from '@supabase/supabase-js';

const mode = process.env.TWITTER_ANALYTICS_SYNC_CANARY_MODE ?? 'run';
const organizationId = required('TWITTER_CANARY_ORGANIZATION_ID');
const itemId = required('TWITTER_ANALYTICS_ITEM_ID');
const expectedBaseline = integer(required('TWITTER_CANARY_EXPECTED_POSTS_READ'), 0, Number.MAX_SAFE_INTEGER);
const admin = createClient(required('NEXT_PUBLIC_SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
const zernioBaseUrl = (process.env.ZERNIO_API_BASE_URL ?? 'https://zernio.com/api').replace(/\/$/, '');
const timeoutMs = integer(process.env.TWITTER_ZERNIO_REQUEST_TIMEOUT_MS ?? '30000', 5_000, 60_000);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

function integer(value, minimum, maximum) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`Valor fora do intervalo ${minimum}-${maximum}.`);
  return parsed;
}

function decryptToken(payload) {
  const [version, iv, tag, ciphertext] = String(payload).split('.');
  if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('Credencial cifrada inválida.');
  const key = Buffer.from(required('TOKEN_ENCRYPTION_KEY'), 'base64');
  if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY inválida.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

async function loadContext() {
  const itemResult = await admin.from('twitter_analytics_items')
    .select('id,job_id,organization_id,connection_id,identity_id,status,result_code,reserved_units,unit_cost_micros,amount_micros,zernio_post_id')
    .eq('id', itemId).eq('organization_id', organizationId).single();
  if (itemResult.error || !itemResult.data) throw itemResult.error ?? new Error('Item Analytics indisponível.');
  const item = itemResult.data;
  const [connectionResult, reservationResult, attemptsResult, publishedResult, membershipResult] = await Promise.all([
    admin.from('twitter_connections')
      .select('id,identity_id,analytics_enabled,inbox_enabled,status,twitter_connection_secrets!inner(encrypted_api_key)')
      .eq('id', item.connection_id).eq('organization_id', organizationId).eq('status', 'active').is('deleted_at', null).single(),
    admin.from('twitter_wallet_reservations').select('id,status,remaining_micros,settled_micros,released_micros')
      .eq('source_id', item.job_id).eq('organization_id', organizationId).single(),
    admin.from('twitter_analytics_items').select('id,status').eq('organization_id', organizationId).in('status', ['reserved', 'processing', 'outcome_unknown']),
    admin.from('twitter_publication_items').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).eq('status', 'published'),
    admin.from('organization_members').select('user_id').eq('organization_id', organizationId).eq('role', 'admin').order('joined_at').limit(1).single(),
  ]);
  for (const result of [connectionResult, reservationResult, attemptsResult, publishedResult, membershipResult]) if (result.error) throw result.error;
  const connection = connectionResult.data;
  const reservation = reservationResult.data;
  if (!connection || !reservation || !membershipResult.data) throw new Error('Contexto do canário incompleto.');
  if (item.status !== 'outcome_unknown' || item.result_code !== 'billing_pending' || Number(item.reserved_units) !== 9
    || Number(item.unit_cost_micros) !== 5_000 || Number(item.amount_micros) !== 45_000 || !item.zernio_post_id) throw new Error('Item não está no estado fan-out esperado.');
  if (attemptsResult.data?.length !== 1 || attemptsResult.data[0].id !== item.id) throw new Error('Existe outro item Analytics não terminal.');
  if (reservation.status !== 'open' || Number(reservation.remaining_micros) !== 45_000
    || Number(reservation.settled_micros) !== 0 || Number(reservation.released_micros) !== 0) throw new Error('Reserva fan-out não está integralmente aberta.');
  if (connection.identity_id !== item.identity_id || connection.analytics_enabled !== false || connection.inbox_enabled !== false) throw new Error('Capabilities locais não começaram desligadas.');
  const publishedPosts = publishedResult.count ?? 0;
  if (publishedPosts < 1 || publishedPosts > Number(item.reserved_units)) throw new Error('Quantidade de posts locais excede a cobertura de nove leituras.');
  const relation = connection.twitter_connection_secrets;
  const secret = Array.isArray(relation) ? relation[0] : relation;
  if (!secret?.encrypted_api_key) throw new Error('Credencial cifrada indisponível.');
  const epochsResult = await admin.from('twitter_profile_connection_epochs').select('zernio_account_id')
    .eq('organization_id', organizationId).eq('connection_id', connection.id).is('ended_at', null);
  if (epochsResult.error) throw epochsResult.error;
  const accountIds = [...new Set((epochsResult.data ?? []).map((row) => row.zernio_account_id).filter(Boolean))];
  if (accountIds.length !== 1) throw new Error('O canário exige exatamente uma conta X ativa.');
  return { item, connection, reservation, actorUserId: membershipResult.data.user_id, apiKey: decryptToken(secret.encrypted_api_key), accountIds, publishedPosts };
}

async function setRemoteCapabilities(apiKey, accountIds, analytics) {
  for (const accountId of accountIds) {
    const response = await fetch(`${zernioBaseUrl}/v1/accounts/${encodeURIComponent(accountId)}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ xCapabilities: { analytics, inbox: false } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Zernio HTTP ${response.status} ao configurar capability.`);
    const payload = await response.json().catch(() => ({}));
    if (payload?.xCapabilities?.analytics !== analytics || payload?.xCapabilities?.inbox !== false) throw new Error('A Zernio não confirmou as capabilities solicitadas.');
  }
}

async function recordCapabilities(context, analytics, key, justification) {
  const result = await admin.rpc('twitter_set_connection_capabilities', {
    p_organization_id: organizationId,
    p_connection_id: context.connection.id,
    p_analytics_enabled: analytics,
    p_inbox_enabled: false,
    p_actor_user_id: context.actorUserId,
    p_actor_email: null,
    p_justification: justification,
    p_idempotency_key: key,
  });
  if (result.error) throw result.error;
}

async function usage(apiKey) {
  const response = await fetch(`${zernioBaseUrl}/v1/usage`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Zernio HTTP ${response.status} ao ler usage.`);
  const payload = await response.json();
  const postsRead = Number(payload?.usage?.xApiCallsByOperation?.posts_read ?? 0);
  if (!Number.isSafeInteger(postsRead) || postsRead < 0) throw new Error('Contador posts_read inválido.');
  return postsRead;
}

async function triggerSinglePostRead(context) {
  const accountId = context.accountIds[0];
  const endpoint = `/v1/analytics?postId=${encodeURIComponent(context.item.zernio_post_id)}&platform=twitter&accountId=${encodeURIComponent(accountId)}`;
  const response = await fetch(`${zernioBaseUrl}${endpoint}`, {
    headers: { authorization: `Bearer ${context.apiKey}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  return {
    httpStatus: response.status,
    syncStatus: typeof payload?.syncStatus === 'string' ? payload.syncStatus.slice(0, 40) : null,
    hasAnalytics: Boolean(payload?.analytics || payload?.platformAnalytics),
  };
}

async function forceDisable(context, sourceId, reason) {
  let remoteError;
  try { await setRemoteCapabilities(context.apiKey, context.accountIds, false); } catch (error) { remoteError = error; }
  await recordCapabilities(context, false, `fanout-sync-disable:${sourceId}`, reason);
  if (remoteError) throw remoteError;
}

async function watchdog() {
  const sourceId = required('TWITTER_ANALYTICS_SYNC_SOURCE_ID');
  const delaySeconds = integer(required('TWITTER_ANALYTICS_SYNC_WATCHDOG_SECONDS'), 90, 900);
  await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1_000));
  const context = await loadContext();
  await forceDisable(context, sourceId, 'Watchdog independente encerrou o Analytics sync do canário fan-out.');
}

async function run() {
  if (required('TWITTER_ANALYTICS_SYNC_CANARY_CONFIRM') !== 'enable-once-disable-and-audit-existing-hold') throw new Error('Confirmação operacional inválida.');
  const durationSeconds = integer(process.env.TWITTER_ANALYTICS_SYNC_CANARY_SECONDS ?? '120', 60, 300);
  const settleSeconds = integer(process.env.TWITTER_ANALYTICS_SYNC_SETTLE_SECONDS ?? '30', 20, 90);
  const context = await loadContext();
  const baseline = await usage(context.apiKey);
  if (baseline !== expectedBaseline) throw new Error(`Baseline mudou de ${expectedBaseline} para ${baseline}; não ativar.`);
  const sourceId = randomUUID();
  const watchdogProcess = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      TWITTER_ANALYTICS_SYNC_CANARY_MODE: 'watchdog',
      TWITTER_ANALYTICS_SYNC_SOURCE_ID: sourceId,
      TWITTER_ANALYTICS_SYNC_WATCHDOG_SECONDS: String(durationSeconds + (settleSeconds * 2) + 90),
    },
  });
  watchdogProcess.unref();

  let runError;
  let disableConfirmed = false;
  let triggerResult;
  try {
    await recordCapabilities(context, true, `fanout-sync-enable:${sourceId}`, 'Canário fan-out: ativação temporária coberta pela reserva existente de nove leituras.');
    await setRemoteCapabilities(context.apiKey, context.accountIds, true);
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    triggerResult = await triggerSinglePostRead(context);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, durationSeconds - 15) * 1_000));
  } catch (error) {
    runError = error;
  } finally {
    try {
      await forceDisable(context, sourceId, 'Encerramento obrigatório da janela temporária do canário fan-out.');
      disableConfirmed = true;
    } catch (error) {
      runError ??= error;
    }
  }

  let firstFinal;
  let secondFinal;
  try {
    await new Promise((resolve) => setTimeout(resolve, settleSeconds * 1_000));
    firstFinal = await usage(context.apiKey);
    await new Promise((resolve) => setTimeout(resolve, settleSeconds * 1_000));
    secondFinal = await usage(context.apiKey);
  } catch (error) {
    runError ??= error;
  }
  const delta = secondFinal == null ? null : secondFinal - baseline;
  const stable = firstFinal != null && secondFinal === firstFinal;
  const covered = Number.isSafeInteger(delta) && delta >= 0 && delta <= Number(context.item.reserved_units);
  if (!disableConfirmed || !stable || !covered || runError) throw runError ?? new Error('Janela encerrada, mas medição final exige reconciliação manual.');
  process.stdout.write(`${JSON.stringify({ sourceId, itemId, publishedLocalPosts: context.publishedPosts, reservedUnits: context.item.reserved_units, triggerRequestCount: 1, triggerResult, baselinePostReads: baseline, finalPostReads: secondFinal, billedReads: delta, stableUsageSnapshots: 2, analyticsEnabled: false, inboxEnabled: false, readyToSettle: delta > 0 }, null, 2)}\n`);
}

(mode === 'watchdog' ? watchdog() : run()).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Falha desconhecida.'}\n`);
  process.exitCode = 1;
});
