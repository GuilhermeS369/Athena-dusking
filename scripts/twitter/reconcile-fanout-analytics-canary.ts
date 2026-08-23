import { createSupabaseAdminClient } from '../../lib/supabase/admin';
import { loadTwitterZernioConnection } from '../../lib/twitter/zernio-connections';

const UNIT_MICROS = 5_000;
const MAX_UNITS = 9;
const MAXIMUM_MICROS = UNIT_MICROS * MAX_UNITS;

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

function integer(value: unknown, label: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} inválido.`);
  return parsed;
}

function object(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function main() {
  const action = required('TWITTER_CANARY_CONFIRM');
  if (!['audit-fanout-canary-billing', 'settle-fanout-canary-billing', 'settle-fanout-canary-zero-after-synced-read'].includes(action)) throw new Error('Confirmação operacional inválida.');
  const organizationId = required('TWITTER_CANARY_ORGANIZATION_ID');
  const itemId = required('TWITTER_ANALYTICS_ITEM_ID');
  const expectedBaseline = integer(required('TWITTER_CANARY_EXPECTED_POSTS_READ'), 'Baseline esperado');
  const admin = createSupabaseAdminClient();

  const [itemResult, attemptResult, walletResult, connectionResult, unresolvedResult, snapshotsBefore] = await Promise.all([
    admin.from('twitter_analytics_items').select('id,job_id,organization_id,identity_id,connection_id,status,result_code,amount_micros,unit_cost_micros,reserved_units,settled_units,released_micros,billing_contract_version,attempt_count').eq('id', itemId).eq('organization_id', organizationId).single(),
    admin.from('twitter_analytics_attempts').select('id,item_id,status,http_status,provider_code,evidence').eq('item_id', itemId).single(),
    admin.from('twitter_wallets').select('identity_id,posted_balance_micros,reserved_micros,version').eq('organization_id', organizationId).single(),
    admin.from('twitter_connections').select('id,identity_id,status,analytics_enabled,inbox_enabled').eq('organization_id', organizationId).eq('status', 'active').is('deleted_at', null).single(),
    admin.from('twitter_analytics_items').select('id,status').eq('organization_id', organizationId).in('status', ['reserved', 'processing', 'outcome_unknown']),
    admin.from('twitter_analytics_snapshots').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId),
  ]);
  for (const result of [itemResult, attemptResult, walletResult, connectionResult, unresolvedResult, snapshotsBefore]) if (result.error) throw result.error;
  if (!itemResult.data || !attemptResult.data || !walletResult.data || !connectionResult.data) throw new Error('Estado do canário incompleto.');
  const item = itemResult.data;
  const attempt = attemptResult.data;
  const walletBefore = walletResult.data;
  const connection = connectionResult.data;
  const evidence = object(attempt.evidence);
  const pendingMetrics = object(evidence.pendingMetrics);
  const baselineOperations = object(evidence.usageBaselineOperations);
  if (item.status !== 'outcome_unknown' || item.result_code !== 'billing_pending' || Number(item.amount_micros) !== MAXIMUM_MICROS
    || Number(item.unit_cost_micros) !== UNIT_MICROS || Number(item.reserved_units) !== MAX_UNITS || Number(item.settled_units) !== 0
    || Number(item.released_micros) !== 0 || Number(item.billing_contract_version) !== 2 || Number(item.attempt_count) !== 1) {
    throw new Error('Item fan-out não está no estado billing_pending esperado.');
  }
  if (attempt.status !== 'outcome_unknown' || attempt.http_status !== 200 || attempt.provider_code !== 'billing_pending' || Object.keys(pendingMetrics).length === 0) {
    throw new Error('Tentativa HTTP 200 não preserva métricas pendentes válidas.');
  }
  if (integer(baselineOperations.posts_read ?? 0, 'Baseline da tentativa') !== expectedBaseline) throw new Error('Baseline persistido diverge do baseline operacional.');
  if (walletBefore.identity_id !== item.identity_id || Number(walletBefore.reserved_micros) !== MAXIMUM_MICROS) throw new Error('Carteira não mantém exatamente o hold do canário.');
  if (connection.id !== item.connection_id || connection.identity_id !== item.identity_id || connection.analytics_enabled !== false || connection.inbox_enabled !== false) {
    throw new Error('Conexão ou capabilities não estão no estado seguro.');
  }
  if (unresolvedResult.data?.length !== 1 || unresolvedResult.data[0].id !== item.id) throw new Error('Existe outro item Analytics não terminal.');
  if ((snapshotsBefore.count ?? 0) !== 0) throw new Error('Snapshot inesperado antes da reconciliação.');
  const { data: reservations, error: reservationsError } = await admin.from('twitter_wallet_reservations').select('id,status,initial_micros,remaining_micros,settled_micros,released_micros').eq('source_id', item.job_id);
  if (reservationsError) throw reservationsError;
  const reservation = reservations?.[0];
  if (reservations?.length !== 1 || reservation?.status !== 'open' || Number(reservation.initial_micros) !== MAXIMUM_MICROS
    || Number(reservation.remaining_micros) !== MAXIMUM_MICROS || Number(reservation.settled_micros) !== 0 || Number(reservation.released_micros) !== 0) {
    throw new Error('Reserva do canário não está integralmente aberta.');
  }

  const { client } = await loadTwitterZernioConnection(organizationId, connection.id);
  const usage = await client.getUsageSnapshot();
  const observedPostReads = integer(usage.usage?.xApiCallsByOperation?.posts_read ?? 0, 'posts_read observado');
  const billedUnits = observedPostReads - expectedBaseline;
  if (billedUnits < 0 || billedUnits > MAX_UNITS) throw new Error('Delta posts_read está fora da cobertura da reserva.');
  const audit = {
    action,
    itemId,
    attemptId: attempt.id,
    baselinePostReads: expectedBaseline,
    observedPostReads,
    billedUnits,
    maximumUnits: MAX_UNITS,
    pendingMetrics: true,
    walletBefore,
    reservation,
  };
  if (action === 'audit-fanout-canary-billing') {
    process.stdout.write(`${JSON.stringify({ ...audit, readOnly: true, readyToSettle: billedUnits > 0 }, null, 2)}\n`);
    return;
  }
  const settleZero = action === 'settle-fanout-canary-zero-after-synced-read';
  if (billedUnits === 0 && !settleZero) throw new Error('Metering ainda não registrou a leitura; manter hold e repetir somente a auditoria.');
  if (billedUnits > 0 && settleZero) throw new Error('Metering registrou cobrança; use a liquidação pelo delta positivo.');
  const expectedObserved = integer(required('TWITTER_CANARY_EXPECTED_OBSERVED_POSTS_READ'), 'Contador final esperado');
  if (expectedObserved !== observedPostReads) throw new Error('Contador final mudou; execute nova auditoria.');

  let controlledSyncEvidence: Record<string, unknown> = {};
  if (settleZero) {
    const syncSourceId = required('TWITTER_ANALYTICS_SYNC_SOURCE_ID');
    const { data: capabilityEvents, error: capabilityEventsError } = await admin.from('twitter_connection_events')
      .select('idempotency_key,metadata')
      .eq('organization_id', organizationId)
      .eq('connection_id', connection.id)
      .in('idempotency_key', [`fanout-sync-enable:${syncSourceId}`, `fanout-sync-disable:${syncSourceId}`]);
    if (capabilityEventsError) throw capabilityEventsError;
    const enabled = capabilityEvents?.find((event) => event.idempotency_key === `fanout-sync-enable:${syncSourceId}`);
    const disabled = capabilityEvents?.find((event) => event.idempotency_key === `fanout-sync-disable:${syncSourceId}`);
    if (capabilityEvents?.length !== 2 || object(enabled?.metadata).analyticsEnabled !== true || object(disabled?.metadata).analyticsEnabled !== false) {
      throw new Error('Eventos imutáveis de ativação e desligamento do sync não foram comprovados.');
    }
    controlledSyncEvidence = {
      sourceId: syncSourceId,
      requestCount: 1,
      triggerHttpStatus: 200,
      triggerSyncStatus: 'synced',
      triggerHadAnalytics: true,
      providerCounterUnchanged: true,
      lateUsageReconciliationRequired: true,
    };
  }

  const secondUsage = await client.getUsageSnapshot();
  const stablePostReads = integer(secondUsage.usage?.xApiCallsByOperation?.posts_read ?? 0, 'Segundo posts_read observado');
  if (stablePostReads !== observedPostReads) throw new Error('Metering ainda está mudando; manter o hold.');
  const { data: settled, error: settleError } = await admin.rpc('twitter_complete_analytics_item', {
    p_attempt_id: attempt.id,
    p_resolution: 'succeeded',
    p_idempotency_key: `fanout-canary-billing:${attempt.id}:${expectedBaseline}:${observedPostReads}:${settleZero ? 'zero-synced-v1' : 'v1'}`,
    p_metrics: pendingMetrics,
    p_provider_updated_at: new Date().toISOString(),
    p_http_status: 200,
    p_provider_code: settleZero ? 'billing_reconciled_zero' : 'billing_reconciled',
    p_request_id: null,
    p_message: settleZero
      ? 'HTTP 200 synced reconciliado sem débito após janela controlada e contador posts_read estável.'
      : 'HTTP 200 reconciliado pelo delta estável de posts_read da Zernio.',
    p_evidence: {
      ...evidence,
      billingProof: true,
      billingSource: 'GET /v1/usage',
      baselinePostReads: expectedBaseline,
      observedPostReads,
      billedUnits,
      reconciledBy: 'reconcile-fanout-analytics-canary',
      controlledSyncEvidence,
    },
    p_billed_units: billedUnits,
  });
  if (settleError) throw settleError;
  const [itemAfterResult, attemptAfterResult, reservationAfterResult, walletAfterResult, snapshotsAfter] = await Promise.all([
    admin.from('twitter_analytics_items').select('status,result_code,settled_units,released_micros').eq('id', item.id).single(),
    admin.from('twitter_analytics_attempts').select('status,provider_code,evidence').eq('id', attempt.id).single(),
    admin.from('twitter_wallet_reservations').select('status,remaining_micros,settled_micros,released_micros').eq('id', reservation.id).single(),
    admin.from('twitter_wallets').select('posted_balance_micros,reserved_micros,version').eq('identity_id', item.identity_id).single(),
    admin.from('twitter_analytics_snapshots').select('id', { count: 'exact', head: true }).eq('analytics_item_id', item.id),
  ]);
  for (const result of [itemAfterResult, attemptAfterResult, reservationAfterResult, walletAfterResult, snapshotsAfter]) if (result.error) throw result.error;
  if (!itemAfterResult.data || !attemptAfterResult.data || !reservationAfterResult.data || !walletAfterResult.data) throw new Error('Estado final da liquidação incompleto.');
  const expectedSettledMicros = billedUnits * UNIT_MICROS;
  const expectedReleasedMicros = MAXIMUM_MICROS - expectedSettledMicros;
  const itemAfter = itemAfterResult.data;
  const attemptAfter = attemptAfterResult.data;
  const reservationAfter = reservationAfterResult.data;
  const walletAfter = walletAfterResult.data;
  const expectedProviderCode = settleZero ? 'billing_reconciled_zero' : 'billing_reconciled';
  const expectedReservationStatus = expectedSettledMicros === 0 ? 'released' : 'settled';
  const valid = itemAfter.status === 'succeeded' && itemAfter.result_code === expectedProviderCode
    && Number(itemAfter.settled_units) === billedUnits && Number(itemAfter.released_micros) === expectedReleasedMicros
    && attemptAfter.status === 'succeeded' && attemptAfter.provider_code === expectedProviderCode && object(attemptAfter.evidence).billingProof === true
    && reservationAfter.status === expectedReservationStatus && Number(reservationAfter.remaining_micros) === 0
    && Number(reservationAfter.settled_micros) === expectedSettledMicros && Number(reservationAfter.released_micros) === expectedReleasedMicros
    && Number(walletAfter.posted_balance_micros) === Number(walletBefore.posted_balance_micros) - expectedSettledMicros
    && Number(walletAfter.reserved_micros) === 0 && Number(walletAfter.version) === Number(walletBefore.version) + 1
    && (snapshotsAfter.count ?? 0) === 1;
  if (!valid) throw new Error('Liquidação ocorreu, mas o estado final exige auditoria manual imediata.');
  process.stdout.write(`${JSON.stringify({ ...audit, readOnly: false, settled, itemAfter, reservationAfter, walletAfter, snapshotCount: snapshotsAfter.count }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Falha desconhecida.'}\n`);
  process.exitCode = 1;
});
