#!/usr/bin/env node
import { createDecipheriv, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createClient } from '@supabase/supabase-js';

const mode = process.env.TWITTER_CAPABILITY_CANARY_MODE ?? 'run';
const organizationId = required('TWITTER_CANARY_ORGANIZATION_ID');
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

async function connectionContext(connectionId) {
  let query = admin.from('twitter_connections')
    .select('id,identity_id,analytics_enabled,inbox_enabled,twitter_connection_secrets!inner(encrypted_api_key)')
    .eq('organization_id', organizationId).eq('status', 'active').is('deleted_at', null);
  if (connectionId) query = query.eq('id', connectionId);
  const { data, error } = await query;
  if (error || data?.length !== 1) throw new Error('O canário exige exatamente uma conexão X ativa no escopo.');
  const relation = data[0].twitter_connection_secrets;
  const secret = Array.isArray(relation) ? relation[0] : relation;
  const { data: epochs, error: epochError } = await admin.from('twitter_profile_connection_epochs')
    .select('zernio_account_id').eq('organization_id', organizationId).eq('connection_id', data[0].id).is('ended_at', null);
  if (epochError) throw epochError;
  const accountIds = [...new Set((epochs ?? []).map((row) => row.zernio_account_id).filter(Boolean))];
  if (!secret?.encrypted_api_key || accountIds.length === 0) throw new Error('Credencial ou conta X ativa indisponível.');
  return { connection: data[0], apiKey: decryptToken(secret.encrypted_api_key), accountIds };
}

async function setRemoteCapabilities(apiKey, accountIds, analytics) {
  const results = await Promise.allSettled(accountIds.map(async (accountId) => {
    const response = await fetch(`${zernioBaseUrl}/v1/accounts/${encodeURIComponent(accountId)}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ xCapabilities: { analytics, inbox: false } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Zernio HTTP ${response.status} ao configurar capability.`);
    const payload = await response.json().catch(() => ({}));
    if (payload?.xCapabilities?.analytics !== analytics || payload?.xCapabilities?.inbox !== false) {
      throw new Error('A Zernio não confirmou as capabilities solicitadas.');
    }
  }));
  if (results.some((result) => result.status === 'rejected')) throw new Error('Falha ao confirmar capability em todas as contas X.');
}

async function recordCapabilities(connectionId, actorUserId, analytics, idempotencyKey, justification) {
  const { error } = await admin.rpc('twitter_set_connection_capabilities', {
    p_organization_id: organizationId,
    p_connection_id: connectionId,
    p_analytics_enabled: analytics,
    p_inbox_enabled: false,
    p_actor_user_id: actorUserId,
    p_actor_email: null,
    p_justification: justification,
    p_idempotency_key: idempotencyKey,
  });
  if (error) throw error;
}

async function usage(apiKey) {
  const response = await fetch(`${zernioBaseUrl}/v1/usage`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Zernio HTTP ${response.status} ao ler usage.`);
  const payload = await response.json();
  const operations = payload?.usage?.xApiCallsByOperation ?? {};
  return { postsRead: Number(operations.posts_read ?? 0), operations };
}

async function forceDisable(connectionId, actorUserId, reason) {
  const context = await connectionContext(connectionId);
  await setRemoteCapabilities(context.apiKey, context.accountIds, false);
  await recordCapabilities(context.connection.id, actorUserId, false, `capability-disable:${randomUUID()}`, reason);
  return context;
}

async function watchdog() {
  const delaySeconds = integer(required('TWITTER_CAPABILITY_WATCHDOG_DELAY_SECONDS'), 60, 1_200);
  const connectionId = required('TWITTER_CAPABILITY_CONNECTION_ID');
  const actorUserId = required('TWITTER_CAPABILITY_ACTOR_USER_ID');
  await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1_000));
  await forceDisable(connectionId, actorUserId, 'Watchdog independente encerrou a janela de Analytics sync.');
}

async function run() {
  if (required('TWITTER_CAPABILITY_CANARY_CONFIRM') !== 'reserve-enable-disable-and-audit') throw new Error('Confirmação operacional inválida.');
  const durationSeconds = integer(process.env.TWITTER_CAPABILITY_CANARY_SECONDS ?? '600', 60, 900);
  const settleDelaySeconds = integer(process.env.TWITTER_CAPABILITY_USAGE_SETTLE_SECONDS ?? '60', 30, 180);
  const context = await connectionContext();
  if (context.connection.analytics_enabled || context.connection.inbox_enabled) throw new Error('Capabilities não começaram desligadas.');
  const [{ data: membership }, { data: wallet }, { data: card }, publishedResult, openReservations] = await Promise.all([
    admin.from('organization_members').select('user_id,role').eq('organization_id', organizationId).eq('role', 'admin').order('joined_at').limit(1).single(),
    admin.from('twitter_wallets').select('posted_balance_micros,reserved_micros,version').eq('identity_id', context.connection.identity_id).single(),
    admin.from('twitter_rate_cards').select('version').eq('active', true).single(),
    admin.from('twitter_publication_items').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).eq('connection_id', context.connection.id).eq('status', 'published'),
    admin.from('twitter_wallet_reservations').select('id', { count: 'exact', head: true }).eq('identity_id', context.connection.identity_id).gt('remaining_micros', 0),
  ]);
  if (!membership || !wallet || !card || publishedResult.error || openReservations.error) throw new Error('Baseline local do canário indisponível.');
  if ((openReservations.count ?? 0) !== 0 || Number(wallet.reserved_micros) !== 0) throw new Error('Existe reserva aberta antes do canário.');
  const resourceCount = publishedResult.count ?? 0;
  if (resourceCount < 1 || resourceCount > 1_000) throw new Error('Quantidade de posts publicados fora do limite do canário.');
  const amountMicros = resourceCount * 5_000;
  if (Number(wallet.posted_balance_micros) - amountMicros < 5_000_000) throw new Error('Piso protegido de US$ 5,00 seria violado.');
  const baseline = await usage(context.apiKey);
  if (!Number.isSafeInteger(baseline.postsRead) || baseline.postsRead < 0) throw new Error('Baseline posts_read inválido.');

  const sourceId = randomUUID();
  const { data: reservation, error: reservationError } = await admin.rpc('twitter_create_wallet_reservation', {
    p_organization_id: organizationId,
    p_identity_id: context.connection.identity_id,
    p_connection_id: context.connection.id,
    p_rate_card_version: card.version,
    p_category: 'post_read',
    p_origin: 'analytics',
    p_source_id: sourceId,
    p_amount_micros: amountMicros,
    p_expected_wallet_version: wallet.version,
    p_idempotency_key: `capability-canary:${sourceId}`,
  });
  if (reservationError || !reservation?.reservationId) throw reservationError ?? new Error('Reserva do canário não foi criada.');

  const watchdogProcess = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      TWITTER_CAPABILITY_CANARY_MODE: 'watchdog',
      TWITTER_CAPABILITY_CONNECTION_ID: context.connection.id,
      TWITTER_CAPABILITY_ACTOR_USER_ID: membership.user_id,
      TWITTER_CAPABILITY_WATCHDOG_DELAY_SECONDS: String(durationSeconds + 90),
    },
  });
  watchdogProcess.unref();

  let disableConfirmed = false;
  let runError;
  try {
    await recordCapabilities(context.connection.id, membership.user_id, true, `capability-enable:${sourceId}`, 'Canário financeiro temporário de Analytics sync com reserva integral.');
    await setRemoteCapabilities(context.apiKey, context.accountIds, true);
    await new Promise((resolve) => setTimeout(resolve, durationSeconds * 1_000));
  } catch (error) {
    runError = error;
  } finally {
    try {
      await setRemoteCapabilities(context.apiKey, context.accountIds, false);
      await recordCapabilities(context.connection.id, membership.user_id, false, `capability-disable:${sourceId}`, 'Encerramento obrigatório do canário financeiro de Analytics sync.');
      disableConfirmed = true;
    } catch (error) {
      runError ??= error;
    }
  }

  let finalUsage;
  try {
    await new Promise((resolve) => setTimeout(resolve, settleDelaySeconds * 1_000));
    const firstFinalUsage = await usage(context.apiKey);
    await new Promise((resolve) => setTimeout(resolve, settleDelaySeconds * 1_000));
    const secondFinalUsage = await usage(context.apiKey);
    if (firstFinalUsage.postsRead !== secondFinalUsage.postsRead) throw new Error('Metering ainda mudou entre as duas conferências finais.');
    finalUsage = secondFinalUsage;
  } catch (error) {
    runError ??= error;
  }
  const delta = finalUsage ? finalUsage.postsRead - baseline.postsRead : null;
  const safeDelta = Number.isSafeInteger(delta) && delta >= 0 && delta <= resourceCount;
  if (!disableConfirmed || !safeDelta) {
    await admin.rpc('twitter_mark_reservation_outcome_unknown', {
      p_reservation_id: reservation.reservationId,
      p_idempotency_key: `capability-unknown:${sourceId}`,
      p_reason: 'Desligamento ou medição final do canário não foi comprovado.',
      p_metadata: { sourceId, disableConfirmed, baselinePostsRead: baseline.postsRead, finalPostsRead: finalUsage?.postsRead ?? null },
    });
    throw runError ?? new Error('Canário terminou com resultado financeiro incerto.');
  }
  const settledMicros = delta * 5_000;
  if (settledMicros > 0) {
    const { error } = await admin.rpc('twitter_settle_wallet_reservation', {
      p_reservation_id: reservation.reservationId,
      p_amount_micros: settledMicros,
      p_idempotency_key: `capability-settle:${sourceId}`,
      p_metadata: { sourceId, baselinePostsRead: baseline.postsRead, finalPostsRead: finalUsage.postsRead, durationSeconds, settleDelaySeconds, finalSnapshots: 2 },
    });
    if (error) throw error;
  }
  if (settledMicros < amountMicros) {
    const { error } = await admin.rpc('twitter_release_wallet_reservation', {
      p_reservation_id: reservation.reservationId,
      p_idempotency_key: `capability-release:${sourceId}`,
      p_reason: 'Parcela não utilizada da reserva do canário de Analytics sync.',
      p_manual_resolution: false,
    });
    if (error) throw error;
  }
  if (runError) throw runError;
  process.stdout.write(`${JSON.stringify({ sourceId, reservationId: reservation.reservationId, resourceCount, durationSeconds, settleDelaySeconds, baselinePostsRead: baseline.postsRead, finalPostsRead: finalUsage.postsRead, billingSnapshotsConfirmed: 2, billedReads: delta, settledMicros, releasedMicros: amountMicros - settledMicros, analyticsEnabled: false, inboxEnabled: false }, null, 2)}\n`);
}

(mode === 'watchdog' ? watchdog() : run()).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Falha desconhecida.'}\n`);
  process.exitCode = 1;
});
