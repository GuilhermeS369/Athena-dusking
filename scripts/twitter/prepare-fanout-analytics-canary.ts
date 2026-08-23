import { randomBytes, randomUUID } from 'node:crypto';

import { createSupabaseAdminClient } from '../../lib/supabase/admin';
import { confirmTwitterAnalyticsQuote, prepareTwitterAnalyticsQuote, type TwitterAnalyticsRequest } from '../../lib/twitter/analytics-service';
import { loadTwitterZernioConnection } from '../../lib/twitter/zernio-connections';

const POST_READ_UNIT_MICROS = 5_000;
const POST_READ_RESERVE_UNITS = 9;
const POST_READ_MAXIMUM_MICROS = POST_READ_UNIT_MICROS * POST_READ_RESERVE_UNITS;
const PROTECTED_FLOOR_MICROS = 5_000_000;

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

function safeInteger(value: unknown, label: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} inválido.`);
  return parsed;
}

async function main() {
  const action = required('TWITTER_CANARY_CONFIRM');
  if (!['audit-fanout-post-read', 'reserve-fanout-post-read'].includes(action)) {
    throw new Error('Confirmação operacional inválida para o canário fan-out.');
  }
  const organizationId = required('TWITTER_CANARY_ORGANIZATION_ID');
  const admin = createSupabaseAdminClient();

  const [
    membershipResult,
    connectionsResult,
    walletResult,
    candidatesResult,
    historyResult,
    nonterminalResult,
    openReservationsResult,
    activeHoldsResult,
    jobsBefore,
    attemptsBefore,
    snapshotsBefore,
  ] = await Promise.all([
    admin.from('organization_members').select('user_id,role').eq('organization_id', organizationId).eq('role', 'admin').order('joined_at').limit(1).single(),
    admin.from('twitter_connections').select('id,identity_id,status,analytics_enabled,inbox_enabled').eq('organization_id', organizationId).eq('status', 'active').is('deleted_at', null),
    admin.from('twitter_wallets').select('identity_id,posted_balance_micros,reserved_micros,version').eq('organization_id', organizationId).single(),
    admin.from('twitter_publication_items').select('id,identity_id,connection_id,profile_id,execute_at').eq('organization_id', organizationId).eq('status', 'published').order('execute_at', { ascending: false }).limit(100),
    admin.from('twitter_analytics_items').select('id,publication_item_id,status,result_code,unit_cost_micros,reserved_units,billing_contract_version').eq('organization_id', organizationId),
    admin.from('twitter_analytics_items').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).in('status', ['reserved', 'processing', 'outcome_unknown']),
    admin.from('twitter_wallet_reservations').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).gt('remaining_micros', 0),
    admin.from('twitter_item_holds').select('item_id', { count: 'exact', head: true }).eq('organization_id', organizationId).in('status', ['active', 'outcome_unknown']),
    admin.from('twitter_analytics_jobs').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId),
    admin.from('twitter_analytics_attempts').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId),
    admin.from('twitter_analytics_snapshots').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId),
  ]);

  for (const result of [membershipResult, connectionsResult, walletResult, candidatesResult, historyResult, nonterminalResult, openReservationsResult, activeHoldsResult, jobsBefore, attemptsBefore, snapshotsBefore]) {
    if (result.error) throw result.error;
  }
  const membership = membershipResult.data;
  const connection = connectionsResult.data?.[0];
  const walletBefore = walletResult.data;
  const history = historyResult.data ?? [];
  if (!membership || membership.role !== 'admin' || !walletBefore) throw new Error('Admin ou carteira canário inválido.');
  if (connectionsResult.data?.length !== 1 || !connection) throw new Error('O canário exige exatamente uma conexão X ativa.');
  if (connection.analytics_enabled !== false || connection.inbox_enabled !== false) throw new Error('Analytics e Inbox devem estar desligados antes da reserva.');
  if (connection.identity_id !== walletBefore.identity_id || Number(walletBefore.reserved_micros) !== 0) throw new Error('Carteira da conexão não está livre para o canário.');
  if ((nonterminalResult.count ?? 0) !== 0 || (openReservationsResult.count ?? 0) !== 0 || (activeHoldsResult.count ?? 0) !== 0) {
    throw new Error('Existe fila, reserva ou hold não terminal; o canário foi bloqueado.');
  }
  if ((snapshotsBefore.count ?? 0) !== 0) throw new Error('Já existe snapshot Analytics; não iniciar automaticamente outro canário.');
  if (history.some((item) => !['succeeded', 'failed', 'cancelled'].includes(item.status))) throw new Error('Histórico Analytics possui item não terminal.');
  if (history.some((item) => Number(item.billing_contract_version) >= 2)) throw new Error('Já existe item do contrato fan-out; não criar outro automaticamente.');

  const historicalPublicationIds = new Set(history.map((item) => item.publication_item_id).filter(Boolean));
  const eligibleCandidates = (candidatesResult.data ?? []).filter((item) => (
    item.connection_id === connection.id
    && item.identity_id === connection.identity_id
    && !historicalPublicationIds.has(item.id)
  ));
  if (eligibleCandidates.length === 0) throw new Error('Nenhum post publicado inédito está disponível para o canário.');
  const { data: publishedAttempts, error: publishedAttemptsError } = await admin
    .from('twitter_publication_attempts')
    .select('item_id,post_id,status,created_at')
    .in('item_id', eligibleCandidates.map((item) => item.id))
    .eq('status', 'published')
    .not('post_id', 'is', null)
    .order('created_at', { ascending: false });
  if (publishedAttemptsError) throw publishedAttemptsError;
  const candidate = eligibleCandidates.find((item) => publishedAttempts?.some((attempt) => attempt.item_id === item.id && attempt.post_id));
  if (!candidate) throw new Error('Nenhum post inédito possui ID remoto publicado confirmado.');

  const { client } = await loadTwitterZernioConnection(organizationId, connection.id);
  const usage = await client.getUsageSnapshot();
  const operations = usage.usage?.xApiCallsByOperation ?? {};
  const baselinePostReads = safeInteger(operations.posts_read ?? 0, 'Baseline posts_read');
  const baselineSpendCents = safeInteger(usage.spend?.xSpendCents ?? 0, 'Baseline xSpendCents');
  if (action === 'reserve-fanout-post-read') {
    const expectedPostReads = safeInteger(required('TWITTER_CANARY_EXPECTED_POSTS_READ'), 'TWITTER_CANARY_EXPECTED_POSTS_READ');
    if (expectedPostReads !== baselinePostReads) throw new Error('Baseline posts_read mudou; execute uma nova auditoria antes de reservar.');
  }

  process.env.TWITTER_REVIEW_TOKEN_SECRET ??= randomBytes(32).toString('base64url');
  const request: TwitterAnalyticsRequest = { postIds: [candidate.id], profileIds: [] };
  const quote = await prepareTwitterAnalyticsQuote(organizationId, request);
  const walletQuote = quote.walletSnapshots[0];
  const quoteValid = quote.resourceCount === 1
    && quote.postCount === 1
    && quote.profileCount === 0
    && quote.totalMicros === POST_READ_MAXIMUM_MICROS
    && quote.postReadUnitMicros === POST_READ_UNIT_MICROS
    && quote.postReadReserveUnits === POST_READ_RESERVE_UNITS
    && quote.postReadMaximumMicros === POST_READ_MAXIMUM_MICROS
    && quote.canConfirm
    && quote.walletSnapshots.length === 1
    && walletQuote.analyticsCostMicros === POST_READ_MAXIMUM_MICROS
    && walletQuote.projectedAvailableMicros >= PROTECTED_FLOOR_MICROS;
  if (!quoteValid) throw new Error('Quote fan-out não atende às invariantes financeiras.');

  const baseline = {
    postsRead: baselinePostReads,
    xSpendCents: baselineSpendCents,
    billingSystem: usage.billingSystem ?? null,
  };
  if (action === 'audit-fanout-post-read') {
    const { data: walletAfter, error: walletAfterError } = await admin.from('twitter_wallets').select('identity_id,posted_balance_micros,reserved_micros,version').eq('organization_id', organizationId).single();
    if (walletAfterError) throw walletAfterError;
    if (JSON.stringify(walletAfter) !== JSON.stringify(walletBefore)) throw new Error('A auditoria read-only alterou a carteira.');
    process.stdout.write(`${JSON.stringify({
      action,
      readOnly: true,
      candidateItemId: candidate.id,
      historicalResourcesExcluded: historicalPublicationIds.size,
      baseline,
      quote: {
        resourceCount: quote.resourceCount,
        unitMicros: quote.postReadUnitMicros,
        reserveUnits: quote.postReadReserveUnits,
        maximumMicros: quote.totalMicros,
        projectedAvailableMicros: walletQuote.projectedAvailableMicros,
        protectedFloorMicros: walletQuote.protectedFloorMicros,
        canConfirm: quote.canConfirm,
      },
      walletBefore,
      walletAfter,
    }, null, 2)}\n`);
    return;
  }

  const confirmed = await confirmTwitterAnalyticsQuote({
    organizationId,
    actorUserId: membership.user_id,
    request,
    reviewToken: quote.reviewToken,
    idempotencyKey: `twitter-canary-analytics-fanout-v2:${candidate.id}:${randomUUID()}`,
  }) as Record<string, unknown>;
  const jobId = String(confirmed.jobId ?? '');
  const [jobResult, itemsResult, reservationsResult, walletAfterResult, attemptsAfter, snapshotsAfter] = await Promise.all([
    admin.from('twitter_analytics_jobs').select('status,resource_count,reserved_micros').eq('id', jobId).single(),
    admin.from('twitter_analytics_items').select('id,status,publication_item_id,category,amount_micros,unit_cost_micros,reserved_units,settled_units,released_micros,billing_contract_version,attempt_count,zernio_post_id').eq('job_id', jobId),
    admin.from('twitter_wallet_reservations').select('status,origin,category,initial_micros,remaining_micros,settled_micros,released_micros').eq('source_id', jobId),
    admin.from('twitter_wallets').select('identity_id,posted_balance_micros,reserved_micros,version').eq('organization_id', organizationId).single(),
    admin.from('twitter_analytics_attempts').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId),
    admin.from('twitter_analytics_snapshots').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId),
  ]);
  for (const result of [jobResult, itemsResult, reservationsResult, walletAfterResult, attemptsAfter, snapshotsAfter]) if (result.error) throw result.error;
  const job = jobResult.data;
  const item = itemsResult.data?.[0];
  const reservation = reservationsResult.data?.[0];
  const walletAfter = walletAfterResult.data;
  const validReservation = jobId
    && Number(confirmed.reservedMicros) === POST_READ_MAXIMUM_MICROS
    && job?.status === 'reserved' && Number(job.resource_count) === 1 && Number(job.reserved_micros) === POST_READ_MAXIMUM_MICROS
    && itemsResult.data?.length === 1 && item?.status === 'reserved' && item.publication_item_id === candidate.id
    && item.category === 'post_read' && Number(item.amount_micros) === POST_READ_MAXIMUM_MICROS
    && Number(item.unit_cost_micros) === POST_READ_UNIT_MICROS && Number(item.reserved_units) === POST_READ_RESERVE_UNITS
    && Number(item.settled_units) === 0 && Number(item.released_micros) === 0 && Number(item.billing_contract_version) === 2
    && Number(item.attempt_count) === 0 && Boolean(item.zernio_post_id)
    && reservationsResult.data?.length === 1 && reservation?.status === 'open' && reservation.origin === 'analytics'
    && Number(reservation.initial_micros) === POST_READ_MAXIMUM_MICROS && Number(reservation.remaining_micros) === POST_READ_MAXIMUM_MICROS
    && Number(reservation.settled_micros) === 0 && Number(reservation.released_micros) === 0
    && walletAfter?.identity_id === walletBefore.identity_id
    && Number(walletAfter?.posted_balance_micros) === Number(walletBefore.posted_balance_micros)
    && Number(walletAfter?.reserved_micros) === Number(walletBefore.reserved_micros) + POST_READ_MAXIMUM_MICROS
    && Number(walletAfter?.version) === Number(walletBefore.version) + 1
    && (attemptsAfter.count ?? 0) === (attemptsBefore.count ?? 0)
    && (snapshotsAfter.count ?? 0) === (snapshotsBefore.count ?? 0);
  if (!validReservation) throw new Error('Reserva fan-out foi criada, mas o estado final exige intervenção manual antes de prosseguir.');
  process.stdout.write(`${JSON.stringify({
    action,
    jobId,
    analyticsItemId: item.id,
    candidateItemId: candidate.id,
    baseline,
    reservation: {
      status: reservation.status,
      maximumMicros: POST_READ_MAXIMUM_MICROS,
      unitMicros: POST_READ_UNIT_MICROS,
      reserveUnits: POST_READ_RESERVE_UNITS,
    },
    walletBefore,
    walletAfter,
    nextSafeAction: 'Ativar somente Analytics/worker para Pomodoro e executar exatamente um one-shot; não rodar este script novamente.',
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Falha desconhecida.'}\n`);
  process.exitCode = 1;
});
