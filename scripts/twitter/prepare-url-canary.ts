import { randomBytes, randomUUID } from 'node:crypto';

import { createSupabaseAdminClient } from '../../lib/supabase/admin';
import { confirmTwitterBulkReview, prepareTwitterBulkReview, type TwitterBulkRequest } from '../../lib/twitter/bulk-service';

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

async function main() {
  if (required('TWITTER_CANARY_CONFIRM') !== 'prepare-one-url-post') throw new Error('Confirmação operacional inválida.');
  const organizationId = required('TWITTER_CANARY_ORGANIZATION_ID');
  const delayMinutes = Number(process.env.TWITTER_CANARY_DELAY_MINUTES ?? '10');
  if (!Number.isInteger(delayMinutes) || delayMinutes < 10 || delayMinutes > 60) throw new Error('Delay inválido.');
  const admin = createSupabaseAdminClient();
  const [{ data: membership }, { data: profiles }, nonterminal] = await Promise.all([
    admin.from('organization_members').select('user_id,role').eq('organization_id', organizationId).eq('role', 'admin').order('joined_at').limit(1).single(),
    admin.from('twitter_profiles').select('id').eq('organization_id', organizationId).is('deleted_at', null).eq('status', 'active').eq('can_post', true),
    admin.from('twitter_publication_items').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).in('status', ['ready', 'claimed', 'retry', 'outcome_unknown']),
  ]);
  if (!membership || membership.role !== 'admin' || profiles?.length !== 1) throw new Error('Admin/perfil canário inválido.');
  if ((nonterminal.count ?? 0) !== 0) throw new Error('Existe item X não terminal.');
  process.env.TWITTER_REVIEW_TOKEN_SECRET ??= randomBytes(32).toString('base64url');
  const executeAt = new Date(Date.now() + delayMinutes * 60_000); executeAt.setUTCSeconds(0, 0);
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const request: TwitterBulkRequest = {
    profileIds: [profiles[0].id],
    texts: [`Canário técnico Athena X — custo de URL ${stamp} https://example.com/`],
    mediaSets: [],
    schedule: { kind: 'interval', startsAt: executeAt.toISOString(), intervalMinutes: 1, durationMinutes: 0 },
  };
  const review = await prepareTwitterBulkReview(organizationId, request);
  const reviewedItem = review.items[0];
  if (review.totalRequested !== 1 || review.fundedCount !== 1 || review.unfundedCount !== 0 || review.reservedMicros !== 200_000 || reviewedItem?.category !== 'post_create_url' || reviewedItem?.amount_micros !== 200_000) throw new Error('Review não classificou URL com custo total de 200.000 micros.');
  const confirmed = await confirmTwitterBulkReview({ organizationId, actorUserId: membership.user_id, request, reviewToken: review.reviewToken, idempotencyKey: `twitter-canary-url-${randomUUID()}` }) as Record<string, unknown>;
  const programId = String(confirmed.programId ?? '');
  const [{ data: items }, { data: wallet }, { data: reservations }] = await Promise.all([
    admin.from('twitter_publication_items').select('id,status,execute_at,category,amount_micros,attempt_count,media_set_client_key').eq('program_id', programId),
    admin.from('twitter_wallets').select('posted_balance_micros,reserved_micros,version').eq('organization_id', organizationId).single(),
    admin.from('twitter_wallet_reservations').select('status,remaining_micros').eq('source_id', programId),
  ]);
  const item = items?.[0]; const reservation = reservations?.[0];
  const safe = { programId, itemId: item?.id, item, wallet, reservation };
  if (!programId || items?.length !== 1 || item?.status !== 'ready' || item?.category !== 'post_create_url' || Number(item?.amount_micros) !== 200_000 || Number(item?.attempt_count) !== 0 || item?.media_set_client_key != null || Number(wallet?.reserved_micros) !== 200_000 || reservations?.length !== 1 || reservation?.status !== 'open' || Number(reservation?.remaining_micros) !== 200_000) throw new Error(`Invariantes URL não atendidas: ${JSON.stringify(safe)}`);
  process.stdout.write(`${JSON.stringify(safe, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Falha desconhecida.'}\n`);
  process.exitCode = 1;
});
