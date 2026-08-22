import { createSupabaseAdminClient } from '../../lib/supabase/admin';
import { loadTwitterZernioConnection } from '../../lib/twitter/zernio-connections';

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

function finiteInteger(value: unknown) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

async function main() {
  if (required('TWITTER_USAGE_AUDIT_CONFIRM') !== 'read-zernio-billed-usage') {
    throw new Error('Confirmação operacional inválida.');
  }
  const organizationId = required('TWITTER_CANARY_ORGANIZATION_ID');
  const admin = createSupabaseAdminClient();
  const { data: connections, error } = await admin
    .from('twitter_connections')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('status', 'active')
    .is('deleted_at', null);
  if (error) throw error;
  if (connections?.length !== 1) throw new Error('A auditoria exige exatamente uma conexão X ativa na organização.');

  const { client } = await loadTwitterZernioConnection(organizationId, connections[0].id);
  const snapshot = await client.getUsageSnapshot();
  const operationSource = snapshot.usage?.xApiCallsByOperation ?? {};
  const operations = Object.fromEntries(
    Object.entries(operationSource)
      .map(([key, value]) => [key, finiteInteger(value)] as const)
      .filter((entry): entry is [string, number] => entry[1] !== null)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  const spend = snapshot.spend ?? {};
  process.stdout.write(`${JSON.stringify({
    source: 'GET /v1/usage',
    readOnly: true,
    billingSystem: snapshot.billingSystem ?? null,
    xApiCallsByOperation: operations,
    spend: {
      currentPeriodCents: finiteInteger(spend.currentPeriodCents),
      xSpendCents: finiteInteger(spend.xSpendCents),
      xSpendLimitCents: finiteInteger(spend.xSpendLimitCents),
    },
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Falha desconhecida.'}\n`);
  process.exitCode = 1;
});
