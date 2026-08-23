import { createSupabaseAdminClient } from '../../lib/supabase/admin';
import { loadTwitterZernioConnection } from '../../lib/twitter/zernio-connections';

const usageDate = '2026-08-23';
const observedReads = 27;
const amountMicros = 135_000;
const idempotencyKey = 'provider-usage:2026-08-23:posts-read:27:v1';

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function main() {
  const organizationId = required('TWITTER_CANARY_ORGANIZATION_ID');
  const apply = process.env.TWITTER_PROVIDER_USAGE_RECONCILE_CONFIRM?.trim() === 'reconcile-delayed-posts-read-27';
  const admin = createSupabaseAdminClient();

  const { data: connections, error: connectionError } = await admin
    .from('twitter_connections')
    .select('id,identity_id,analytics_enabled,inbox_enabled')
    .eq('organization_id', organizationId)
    .eq('status', 'active')
    .is('deleted_at', null);
  if (connectionError) throw connectionError;
  if (connections?.length !== 1) throw new Error('A reconciliação exige exatamente uma conexão X ativa.');
  const connection = connections[0];
  if (connection.analytics_enabled || connection.inbox_enabled) throw new Error('Analytics e Inbox precisam permanecer desligados.');

  const { client } = await loadTwitterZernioConnection(organizationId, connection.id);
  const [snapshot, metering, walletResult, rateResult, attemptsResult, snapshotsResult, openReservationsResult, existingResult] = await Promise.all([
    client.getUsageSnapshot(),
    client.getUsageMetering('7d'),
    admin.from('twitter_wallets').select('posted_balance_micros,reserved_micros,version').eq('identity_id', connection.identity_id).single(),
    admin.from('twitter_rate_cards').select('id,version,twitter_cost_rates!inner(category,unit_cost_micros)').eq('active', true).single(),
    admin.from('twitter_analytics_attempts').select('id,status,http_status,provider_code,started_at,finished_at').eq('organization_id', organizationId).eq('http_status', 202),
    admin.from('twitter_analytics_snapshots').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId),
    admin.from('twitter_wallet_reservations').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).gt('remaining_micros', 0),
    admin.from('twitter_provider_usage_reconciliations').select('id,amount_micros').eq('idempotency_key', idempotencyKey).maybeSingle(),
  ]);
  for (const result of [walletResult, rateResult, attemptsResult, snapshotsResult, openReservationsResult, existingResult]) {
    if (result.error) throw result.error;
  }

  const operations = snapshot.usage?.xApiCallsByOperation ?? {};
  if (Number(operations.posts_read ?? 0) !== observedReads) throw new Error('Contador posts_read mudou; interrompendo.');
  if (Number(snapshot.spend?.xSpendCents ?? -1) !== 41) throw new Error('Total X da fatura mudou; interrompendo.');
  const day = (metering.days ?? []).map(object).find((row) => row.date === usageDate);
  if (Number(day?.xApi ?? -1) !== 0.135 || Number(metering.totals?.xApi ?? -1) !== 0.41) {
    throw new Error('Medição diária não corresponde à evidência esperada.');
  }
  if ((attemptsResult.data?.length ?? 0) !== 3 || attemptsResult.data?.some((attempt) => attempt.status !== 'failed')) {
    throw new Error('Os três attempts HTTP 202 reconciliados não correspondem ao baseline.');
  }
  if ((snapshotsResult.count ?? 0) !== 0 || (openReservationsResult.count ?? 0) !== 0 || Number(walletResult.data?.reserved_micros ?? -1) !== 0) {
    throw new Error('Snapshots ou reservas inesperados impedem a reconciliação.');
  }
  const rates = Array.isArray(rateResult.data?.twitter_cost_rates) ? rateResult.data.twitter_cost_rates : [];
  const postReadRate = rates.find((rate) => rate.category === 'post_read');
  if (Number(postReadRate?.unit_cost_micros ?? -1) !== 5_000 || observedReads * Number(postReadRate?.unit_cost_micros ?? 0) !== amountMicros) {
    throw new Error('Rate card post_read incompatível.');
  }

  if (existingResult.data) {
    process.stdout.write(`${JSON.stringify({ idempotentReplay: true, reconciliationId: existingResult.data.id, amountMicros: existingResult.data.amount_micros }, null, 2)}\n`);
    return;
  }

  const { data: members, error: memberError } = await admin
    .from('organization_members')
    .select('user_id,role')
    .eq('organization_id', organizationId)
    .eq('role', 'admin')
    .order('joined_at')
    .limit(1);
  if (memberError) throw memberError;
  const actorUserId = members?.[0]?.user_id ?? null;

  const evidence = {
    source: 'GET /v1/usage',
    billingSystem: snapshot.billingSystem ?? null,
    usageDateUtc: usageDate,
    postsRead: observedReads,
    xApiUsdOnUsageDate: 0.135,
    xApiUsd7d: 0.41,
    xSpendCents: 41,
    relatedHttp202AttemptCount: 3,
    providerCapabilitiesDuringReconciliation: { analytics: false, inbox: false },
    attribution: 'collective_delayed_metering_no_per_attempt_breakdown',
  };
  if (!apply) {
    process.stdout.write(`${JSON.stringify({ dryRun: true, operationCount: observedReads, amountMicros, walletBeforeMicros: walletResult.data?.posted_balance_micros, evidence }, null, 2)}\n`);
    return;
  }

  const { data: reconciliation, error: reconciliationError } = await admin.rpc('twitter_reconcile_provider_usage', {
    p_organization_id: organizationId,
    p_identity_id: connection.identity_id,
    p_connection_id: connection.id,
    p_usage_date: usageDate,
    p_category: 'post_read',
    p_operation_count: observedReads,
    p_observed_operation_total: observedReads,
    p_rate_card_version: rateResult.data?.version,
    p_expected_wallet_version: walletResult.data?.version,
    p_justification: 'Medição Metronome diária confirmou 27 reads atrasadas após três attempts HTTP 202 sem snapshot; débito coletivo sem atribuição artificial por attempt.',
    p_evidence: evidence,
    p_idempotency_key: idempotencyKey,
    p_actor_user_id: actorUserId,
    p_actor_email: null,
  });
  if (reconciliationError) throw reconciliationError;
  process.stdout.write(`${JSON.stringify({ applied: true, reconciliation }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Falha desconhecida.'}\n`);
  process.exitCode = 1;
});

