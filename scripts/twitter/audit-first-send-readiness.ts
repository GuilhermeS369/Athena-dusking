import { createSupabaseAdminClient } from '../../lib/supabase/admin';
import { classifyFirstSendReadiness } from '../../lib/twitter/first-send-readiness.ts';

const EXPECTED_WORKERS = [
  'athena-twitter-publication-worker',
  'athena-twitter-preparation-worker',
  'athena-twitter-zernio-sync-worker',
  'athena-twitter-analytics-worker',
  'athena-twitter-webhook-reconcile-worker',
  'athena-twitter-connect-worker',
  'athena-twitter-observability-worker',
];
const STALE_MS = 120_000;

function optionalUuid(name: string) {
  const value = process.env[name]?.trim();
  if (!value) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${name} não é um UUID válido.`);
  }
  return value;
}

async function exactCount(query: PromiseLike<{ count: number | null; error: { message: string } | null }>) {
  const { count, error } = await query;
  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function main() {
  const organizationId = optionalUuid('TWITTER_FIRST_SEND_ORGANIZATION_ID');
  const connectionId = optionalUuid('TWITTER_FIRST_SEND_CONNECTION_ID');
  const admin = createSupabaseAdminClient();
  let connectionQuery = admin
    .from('twitter_connections')
    .select('id,organization_id,identity_id,label,status,created_at')
    .is('deleted_at', null)
    .order('created_at', { ascending: true });
  if (organizationId) connectionQuery = connectionQuery.eq('organization_id', organizationId);
  if (connectionId) connectionQuery = connectionQuery.eq('id', connectionId);
  const { data: connections, error: connectionError } = await connectionQuery;
  if (connectionError) throw connectionError;

  const now = Date.now();
  const [{ data: heartbeats, error: heartbeatError }, openBreakers] = await Promise.all([
    admin.from('twitter_worker_heartbeats').select('worker_name,mode,last_seen_at'),
    exactCount(admin.from('twitter_circuit_breakers').select('*', { count: 'exact', head: true }).eq('state', 'open')),
  ]);
  if (heartbeatError) throw heartbeatError;
  const heartbeatByName = new Map((heartbeats ?? []).map((row) => [row.worker_name, row]));
  const staleWorkerNames = EXPECTED_WORKERS.filter((name) => {
    const heartbeat = heartbeatByName.get(name);
    return !heartbeat || heartbeat.mode !== 'live' || now - Date.parse(heartbeat.last_seen_at) > STALE_MS;
  });

  const results = [];
  for (const connection of connections ?? []) {
    const [
      activeProfiles,
      postableProfiles,
      walletResult,
      totalItems,
      publishedItems,
      pendingItems,
      unknownItems,
      unknownReservations,
    ] = await Promise.all([
      exactCount(admin.from('twitter_profiles').select('*', { count: 'exact', head: true })
        .eq('current_connection_id', connection.id).is('deleted_at', null)),
      exactCount(admin.from('twitter_profiles').select('*', { count: 'exact', head: true })
        .eq('current_connection_id', connection.id).is('deleted_at', null).eq('can_post', true).eq('token_valid', true)),
      admin.from('twitter_wallets').select('posted_balance_micros,reserved_micros,version')
        .eq('identity_id', connection.identity_id).eq('organization_id', connection.organization_id).maybeSingle(),
      exactCount(admin.from('twitter_publication_items').select('*', { count: 'exact', head: true })
        .eq('connection_id', connection.id)),
      exactCount(admin.from('twitter_publication_items').select('*', { count: 'exact', head: true })
        .eq('connection_id', connection.id).eq('status', 'published')),
      exactCount(admin.from('twitter_publication_items').select('*', { count: 'exact', head: true })
        .eq('connection_id', connection.id).in('status', ['ready', 'retry', 'claimed'])),
      exactCount(admin.from('twitter_publication_items').select('*', { count: 'exact', head: true })
        .eq('connection_id', connection.id).eq('status', 'outcome_unknown')),
      exactCount(admin.from('twitter_wallet_reservations').select('*', { count: 'exact', head: true })
        .eq('connection_id', connection.id).eq('status', 'outcome_unknown')),
    ]);
    if (walletResult.error) throw walletResult.error;
    const wallet = walletResult.data;
    const readiness = classifyFirstSendReadiness({
      connectionActive: connection.status === 'active',
      activeProfiles,
      postableProfiles,
      walletPresent: Boolean(wallet),
      availableMicros: wallet ? Number(wallet.posted_balance_micros) - Number(wallet.reserved_micros) : 0,
      totalItems,
      publishedItems,
      pendingItems,
      unknownItems,
      unknownReservations,
      staleWorkers: staleWorkerNames.length,
      openBreakers,
    });
    results.push({
      organizationId: connection.organization_id,
      connectionId: connection.id,
      label: connection.label,
      connectionStatus: connection.status,
      readiness,
      profiles: { active: activeProfiles, postable: postableProfiles },
      wallet: wallet ? {
        postedMicros: Number(wallet.posted_balance_micros),
        reservedMicros: Number(wallet.reserved_micros),
        availableMicros: Number(wallet.posted_balance_micros) - Number(wallet.reserved_micros),
        version: Number(wallet.version),
      } : null,
      publications: {
        total: totalItems,
        published: publishedItems,
        pending: pendingItems,
        outcomeUnknown: unknownItems,
      },
      financial: { outcomeUnknownReservations: unknownReservations },
    });
  }

  process.stdout.write(`${JSON.stringify({
    checkedAt: new Date(now).toISOString(),
    readOnly: true,
    providerCalls: false,
    filters: { organizationId, connectionId },
    system: { expectedWorkers: EXPECTED_WORKERS.length, staleWorkerNames, openBreakers },
    connections: results,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Falha desconhecida.'}\n`);
  process.exitCode = 1;
});
