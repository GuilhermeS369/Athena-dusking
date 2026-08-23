import { createSupabaseAdminClient } from '../../lib/supabase/admin';
import { loadTwitterZernioConnection } from '../../lib/twitter/zernio-connections';

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

function count(value: unknown, label: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} inválido.`);
  return parsed;
}

async function main() {
  const organizationId = required('TWITTER_CANARY_ORGANIZATION_ID');
  const confirmation = process.env.TWITTER_PROVIDER_USAGE_RECONCILE_CONFIRM?.trim();
  const admin = createSupabaseAdminClient();
  const { data: connections, error: connectionError } = await admin.from('twitter_connections')
    .select('id,identity_id,analytics_enabled,inbox_enabled').eq('organization_id', organizationId)
    .eq('status', 'active').is('deleted_at', null);
  if (connectionError || connections?.length !== 1) throw connectionError ?? new Error('A reconciliação exige exatamente uma conexão X ativa.');
  const connection = connections[0];
  if (connection.analytics_enabled || connection.inbox_enabled) throw new Error('Analytics e Inbox precisam permanecer desligados.');
  const { client } = await loadTwitterZernioConnection(organizationId, connection.id);
  const firstUsage = await client.getUsageSnapshot();
  const secondUsage = await client.getUsageSnapshot();
  const firstObserved = count(firstUsage.usage?.xApiCallsByOperation?.posts_read ?? 0, 'Primeiro posts_read');
  const observed = count(secondUsage.usage?.xApiCallsByOperation?.posts_read ?? 0, 'Segundo posts_read');
  if (firstObserved !== observed) throw new Error('Metering ainda está mudando; repetir somente a auditoria.');

  const [latestResult, walletResult, rateResult, memberResult] = await Promise.all([
    admin.from('twitter_provider_usage_reconciliations').select('observed_operation_total')
      .eq('identity_id', connection.identity_id).eq('category', 'post_read').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    admin.from('twitter_wallets').select('posted_balance_micros,reserved_micros,version').eq('identity_id', connection.identity_id).single(),
    admin.from('twitter_rate_cards').select('version,twitter_cost_rates!inner(category,unit_cost_micros)').eq('active', true).single(),
    admin.from('organization_members').select('user_id').eq('organization_id', organizationId).eq('role', 'admin').order('joined_at').limit(1).single(),
  ]);
  for (const result of [latestResult, walletResult, rateResult, memberResult]) if (result.error) throw result.error;
  const previousObserved = count(latestResult.data?.observed_operation_total ?? 0, 'Baseline reconciliado');
  const operationCount = observed - previousObserved;
  if (operationCount < 0) throw new Error('Contador do provedor regrediu; reconciliação manual obrigatória.');
  const rates = Array.isArray(rateResult.data?.twitter_cost_rates) ? rateResult.data.twitter_cost_rates : [];
  const unitCostMicros = count(rates.find((rate) => rate.category === 'post_read')?.unit_cost_micros, 'Preço post_read');
  const amountMicros = operationCount * unitCostMicros;
  const wallet = walletResult.data;
  if (!wallet || !rateResult.data || !memberResult.data) throw new Error('Estado financeiro incompleto.');
  if (Number(wallet.posted_balance_micros) - Number(wallet.reserved_micros) < amountMicros) throw new Error('Saldo disponível insuficiente para reconciliar o delta tardio.');
  const audit = { previousObserved, observed, operationCount, unitCostMicros, amountMicros, analyticsEnabled: false, inboxEnabled: false };
  if (confirmation !== 'reconcile-current-provider-posts-read-delta') {
    process.stdout.write(`${JSON.stringify({ ...audit, dryRun: true }, null, 2)}\n`);
    return;
  }
  const expectedObserved = count(required('TWITTER_PROVIDER_USAGE_EXPECTED_POSTS_READ'), 'Contador esperado');
  if (operationCount === 0) throw new Error('Nenhum delta novo para reconciliar.');
  if (expectedObserved !== observed) throw new Error('Contador mudou depois da auditoria.');
  const usageDate = new Date().toISOString().slice(0, 10);
  const idempotencyKey = `provider-usage:${usageDate}:posts-read:${observed}:v2`;
  const { data, error } = await admin.rpc('twitter_reconcile_provider_usage', {
    p_organization_id: organizationId,
    p_identity_id: connection.identity_id,
    p_connection_id: connection.id,
    p_usage_date: usageDate,
    p_category: 'post_read',
    p_operation_count: operationCount,
    p_observed_operation_total: observed,
    p_rate_card_version: rateResult.data.version,
    p_expected_wallet_version: wallet.version,
    p_justification: 'Delta tardio confirmado pelo contador cumulativo posts_read da Zernio após capabilities desligadas.',
    p_evidence: { source: 'GET /v1/usage', previousObserved, observed, stableSnapshots: 2, analytics: false, inbox: false },
    p_idempotency_key: idempotencyKey,
    p_actor_user_id: memberResult.data.user_id,
    p_actor_email: null,
  });
  if (error) throw error;
  process.stdout.write(`${JSON.stringify({ ...audit, applied: true, result: data }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Falha desconhecida.'}\n`);
  process.exitCode = 1;
});
