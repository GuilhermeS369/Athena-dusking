import { createSupabaseAdminClient } from '../../lib/supabase/admin';
import { loadTwitterZernioConnection } from '../../lib/twitter/zernio-connections';

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

async function main() {
  if (required('TWITTER_ANALYTICS_RECONCILE_CONFIRM') !== 'release-http-202-not-metered') {
    throw new Error('Confirmação operacional inválida.');
  }
  const organizationId = required('TWITTER_CANARY_ORGANIZATION_ID');
  const attemptId = required('TWITTER_ANALYTICS_ATTEMPT_ID');
  const admin = createSupabaseAdminClient();
  const [{ data: attempt }, { data: membership }, { data: connections }, { data: walletBefore }] = await Promise.all([
    admin.from('twitter_analytics_attempts').select('id,item_id,status,http_status,provider_code').eq('id', attemptId).eq('organization_id', organizationId).single(),
    admin.from('organization_members').select('user_id,role').eq('organization_id', organizationId).eq('role', 'admin').order('joined_at').limit(1).single(),
    admin.from('twitter_connections').select('id').eq('organization_id', organizationId).eq('status', 'active').is('deleted_at', null),
    admin.from('twitter_wallets').select('posted_balance_micros,reserved_micros,version').eq('organization_id', organizationId).single(),
  ]);
  if (!attempt || attempt.status !== 'outcome_unknown' || attempt.http_status !== 202 || attempt.provider_code !== '202') throw new Error('Tentativa não é o HTTP 202 incerto esperado.');
  if (!membership || membership.role !== 'admin') throw new Error('Admin canário indisponível.');
  if (connections?.length !== 1) throw new Error('A reconciliação exige exatamente uma conexão X ativa.');
  if (!walletBefore || Number(walletBefore.reserved_micros) !== 5_000) throw new Error('Reserva global anterior não é exatamente 5.000 micros.');

  const [{ data: item }, snapshotCount, ledgerCount] = await Promise.all([
    admin.from('twitter_analytics_items').select('id,job_id,status,amount_micros').eq('id', attempt.item_id).eq('organization_id', organizationId).single(),
    admin.from('twitter_analytics_snapshots').select('id', { count: 'exact', head: true }).eq('analytics_item_id', attempt.item_id),
    admin.from('twitter_wallet_ledger').select('id', { count: 'exact', head: true }).eq('source_id', attempt.item_id),
  ]);
  if (!item || item.status !== 'outcome_unknown' || Number(item.amount_micros) !== 5_000 || (snapshotCount.count ?? 0) !== 0 || (ledgerCount.count ?? 0) !== 0) {
    throw new Error('Item incerto não atende às invariantes antes da reconciliação.');
  }
  const { data: reservation } = await admin.from('twitter_wallet_reservations')
    .select('id,status,initial_micros,remaining_micros,settled_micros,released_micros')
    .eq('source_id', item.job_id).eq('organization_id', organizationId).eq('origin', 'analytics').single();
  if (!reservation || reservation.status !== 'open' || Number(reservation.initial_micros) !== 5_000 || Number(reservation.remaining_micros) !== 5_000 || Number(reservation.settled_micros) !== 0 || Number(reservation.released_micros) !== 0) {
    throw new Error('Reserva analytics não está integralmente aberta.');
  }

  const { client } = await loadTwitterZernioConnection(organizationId, connections[0].id);
  const usage = await client.getUsageSnapshot();
  const operations = usage.usage?.xApiCallsByOperation ?? {};
  if (Number(operations.content_create) !== 5 || Number(operations.content_create_with_url) !== 1 || Number(operations.posts_read ?? 0) !== 0) {
    throw new Error('Snapshot de billing não comprova a ausência de posts_read.');
  }
  const justification = 'HTTP 202 não foi medido: dois snapshots posteriores de billing exibem as seis criações conhecidas e zero posts_read.';
  const { data: resolution, error } = await admin.rpc('twitter_complete_analytics_item', {
    p_attempt_id: attemptId,
    p_resolution: 'failed',
    p_idempotency_key: `manual-analytics:${attemptId}:billing-no-posts-read-v1`,
    p_metrics: {},
    p_provider_updated_at: null,
    p_http_status: 202,
    p_provider_code: 'manual_not_metered',
    p_request_id: null,
    p_message: 'Analytics não cobrada; reserva liberada após conferência de billing.',
    p_evidence: {
      manual: true,
      actorUserId: membership.user_id,
      justification,
      source: 'GET /v1/usage',
      billingSystem: usage.billingSystem ?? null,
      xApiCallsByOperation: operations,
    },
  });
  if (error) throw error;

  const [{ data: itemAfter }, { data: attemptAfter }, { data: reservationAfter }, { data: walletAfter }, snapshotsAfter, ledgerAfter, { data: resultEvents }] = await Promise.all([
    admin.from('twitter_analytics_items').select('status,result_code,error_message').eq('id', item.id).single(),
    admin.from('twitter_analytics_attempts').select('status,http_status,provider_code,evidence').eq('id', attemptId).single(),
    admin.from('twitter_wallet_reservations').select('status,remaining_micros,settled_micros,released_micros').eq('id', reservation.id).single(),
    admin.from('twitter_wallets').select('posted_balance_micros,reserved_micros,version').eq('organization_id', organizationId).single(),
    admin.from('twitter_analytics_snapshots').select('id', { count: 'exact', head: true }).eq('analytics_item_id', item.id),
    admin.from('twitter_wallet_ledger').select('id', { count: 'exact', head: true }).eq('source_id', item.id),
    admin.from('twitter_analytics_result_events').select('resolution,amount_micros,evidence').eq('item_id', item.id).order('created_at'),
  ]);
  const valid = itemAfter?.status === 'failed' && itemAfter.result_code === 'manual_not_metered'
    && attemptAfter?.status === 'failed' && attemptAfter.provider_code === 'manual_not_metered'
    && reservationAfter?.status === 'released' && Number(reservationAfter.remaining_micros) === 0 && Number(reservationAfter.settled_micros) === 0 && Number(reservationAfter.released_micros) === 5_000
    && Number(walletAfter?.posted_balance_micros) === Number(walletBefore.posted_balance_micros) && Number(walletAfter?.reserved_micros) === 0 && Number(walletAfter?.version) === Number(walletBefore.version) + 1
    && (snapshotsAfter.count ?? 0) === 0 && (ledgerAfter.count ?? 0) === 0
    && resultEvents?.length === 2 && resultEvents[0]?.resolution === 'outcome_unknown' && resultEvents[1]?.resolution === 'failed';
  const safe = { resolution, itemAfter, attemptAfter: attemptAfter ? { ...attemptAfter, evidence: { manual: (attemptAfter.evidence as Record<string, unknown> | null)?.manual === true, source: (attemptAfter.evidence as Record<string, unknown> | null)?.source } } : null, reservationAfter, walletBefore, walletAfter, snapshotCount: snapshotsAfter.count ?? 0, ledgerCount: ledgerAfter.count ?? 0, resultResolutions: resultEvents?.map((event) => event.resolution) ?? [] };
  if (!valid) throw new Error(`Reconciliação não atende às invariantes: ${JSON.stringify(safe)}`);
  process.stdout.write(`${JSON.stringify(safe, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Falha desconhecida.'}\n`);
  process.exitCode = 1;
});
