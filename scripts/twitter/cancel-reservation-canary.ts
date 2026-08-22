import { randomBytes, randomUUID } from 'node:crypto';

import { createSupabaseAdminClient } from '../../lib/supabase/admin';
import { confirmTwitterBulkReview, prepareTwitterBulkReview, type TwitterBulkRequest } from '../../lib/twitter/bulk-service';

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

async function main() {
  if (required('TWITTER_CANARY_CONFIRM') !== 'create-and-cancel-one-local-item') throw new Error('Confirmação operacional inválida.');
  const organizationId = required('TWITTER_CANARY_ORGANIZATION_ID');
  const admin = createSupabaseAdminClient();
  const [{ data: membership }, { data: profiles }, nonterminal, { data: walletBefore }, { data: ledgerBefore }] = await Promise.all([
    admin.from('organization_members').select('user_id,role').eq('organization_id', organizationId).eq('role', 'admin').order('joined_at').limit(1).single(),
    admin.from('twitter_profiles').select('id').eq('organization_id', organizationId).is('deleted_at', null).eq('status', 'active').eq('can_post', true),
    admin.from('twitter_publication_items').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).in('status', ['ready', 'claimed', 'retry', 'processing', 'outcome_unknown']),
    admin.from('twitter_wallets').select('posted_balance_micros,reserved_micros,version').eq('organization_id', organizationId).single(),
    admin.from('twitter_wallet_ledger').select('delta_micros').eq('organization_id', organizationId),
  ]);
  if (!membership || membership.role !== 'admin' || profiles?.length !== 1 || !walletBefore) throw new Error('Organização, admin, perfil ou carteira canário inválido.');
  if ((nonterminal.count ?? 0) !== 0) throw new Error('Existe item X não terminal antes do canário de cancelamento.');
  if (Number(walletBefore.reserved_micros) !== 0) throw new Error('Carteira possui reserva anterior ao canário.');
  const ledgerCountBefore = ledgerBefore?.length ?? 0;
  const ledgerSumBefore = (ledgerBefore ?? []).reduce((sum, row) => sum + Number(row.delta_micros), 0);

  process.env.TWITTER_REVIEW_TOKEN_SECRET ??= randomBytes(32).toString('base64url');
  const executeAt = new Date(Date.now() + 60 * 60_000); executeAt.setUTCSeconds(0, 0);
  const request: TwitterBulkRequest = {
    profileIds: [profiles[0].id],
    texts: [`Canário local Athena X — cancelamento sem chamada externa ${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}`],
    mediaSets: [],
    schedule: { kind: 'interval', startsAt: executeAt.toISOString(), intervalMinutes: 1, durationMinutes: 0 },
  };
  const review = await prepareTwitterBulkReview(organizationId, request);
  if (review.fundedCount !== 1 || review.reservedMicros !== 15_000 || review.items[0]?.category !== 'post_dm_create') throw new Error('Review de cancelamento inválido.');
  const confirmed = await confirmTwitterBulkReview({ organizationId, actorUserId: membership.user_id, request, reviewToken: review.reviewToken, idempotencyKey: `twitter-canary-cancel-program-${randomUUID()}` }) as Record<string, unknown>;
  const programId = String(confirmed.programId ?? '');
  const { data: items } = await admin.from('twitter_publication_items').select('id,status,attempt_count').eq('program_id', programId);
  const itemId = items?.[0]?.id;
  if (!programId || !itemId || items?.length !== 1 || items[0].status !== 'ready' || Number(items[0].attempt_count) !== 0) throw new Error('Item local não foi materializado como ready/0.');

  const cancellationKey = `twitter-canary-cancel-item-${randomUUID()}`;
  const cancelArgs = { p_organization_id: organizationId, p_item_id: itemId, p_program_id: null, p_profile_id: null, p_group_profile_ids: null, p_reason: 'Canário local de devolução idempotente', p_idempotency_key: cancellationKey };
  const first = await admin.rpc('twitter_cancel_publication_scope', cancelArgs);
  if (first.error) throw new Error(`Primeiro cancelamento falhou: ${first.error.message}`);
  const second = await admin.rpc('twitter_cancel_publication_scope', cancelArgs);
  if (second.error) throw new Error(`Segundo cancelamento falhou: ${second.error.message}`);

  const [{ data: itemAfter }, { data: reservations }, { data: holds }, { data: attempts }, { data: walletAfter }, { data: ledgerAfter }] = await Promise.all([
    admin.from('twitter_publication_items').select('status,attempt_count,cancelled_at').eq('id', itemId).single(),
    admin.from('twitter_wallet_reservations').select('status,initial_micros,remaining_micros,settled_micros,released_micros').eq('source_id', programId),
    admin.from('twitter_item_holds').select('status,amount_micros,resolved_at').eq('item_id', itemId),
    admin.from('twitter_publication_attempts').select('id').eq('item_id', itemId),
    admin.from('twitter_wallets').select('posted_balance_micros,reserved_micros,version').eq('organization_id', organizationId).single(),
    admin.from('twitter_wallet_ledger').select('delta_micros').eq('organization_id', organizationId),
  ]);
  const ledgerCountAfter = ledgerAfter?.length ?? 0;
  const ledgerSumAfter = (ledgerAfter ?? []).reduce((sum, row) => sum + Number(row.delta_micros), 0);
  const safe = { programId, itemId, first: first.data, second: second.data, itemAfter, reservation: reservations?.[0], hold: holds?.[0], attemptCount: attempts?.length ?? 0, walletBefore, walletAfter, ledgerCountBefore, ledgerCountAfter, ledgerSumBefore, ledgerSumAfter };
  const valid = (first.data as { affectedItems?:number;releasedMicros?:number })?.affectedItems === 1
    && (first.data as { releasedMicros?:number })?.releasedMicros === 15_000
    && (second.data as { affectedItems?:number;releasedMicros?:number;idempotentReplay?:boolean })?.affectedItems === 0
    && (second.data as { releasedMicros?:number })?.releasedMicros === 0
    && (second.data as { idempotentReplay?:boolean })?.idempotentReplay === true
    && itemAfter?.status === 'cancelled' && Number(itemAfter.attempt_count) === 0 && Boolean(itemAfter.cancelled_at)
    && reservations?.length === 1 && reservations[0].status === 'released' && Number(reservations[0].initial_micros) === 15_000 && Number(reservations[0].remaining_micros) === 0 && Number(reservations[0].settled_micros) === 0 && Number(reservations[0].released_micros) === 15_000
    && holds?.length === 1 && holds[0].status === 'released' && Number(holds[0].amount_micros) === 15_000 && Boolean(holds[0].resolved_at)
    && (attempts?.length ?? 0) === 0
    && Number(walletAfter?.posted_balance_micros) === Number(walletBefore.posted_balance_micros)
    && Number(walletAfter?.reserved_micros) === 0
    && Number(walletAfter?.version) === Number(walletBefore.version) + 2
    && ledgerCountAfter === ledgerCountBefore && ledgerSumAfter === ledgerSumBefore;
  if (!valid) throw new Error(`Invariantes de cancelamento não atendidas: ${JSON.stringify(safe)}`);
  process.stdout.write(`${JSON.stringify(safe, null, 2)}\n`);
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : 'Falha desconhecida.'}\n`); process.exitCode = 1; });
