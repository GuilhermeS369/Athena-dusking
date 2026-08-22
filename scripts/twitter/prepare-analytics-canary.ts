import { randomBytes, randomUUID } from 'node:crypto';

import { createSupabaseAdminClient } from '../../lib/supabase/admin';
import { confirmTwitterAnalyticsQuote, prepareTwitterAnalyticsQuote, type TwitterAnalyticsRequest } from '../../lib/twitter/analytics-service';

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

async function main() {
  const action = required('TWITTER_CANARY_CONFIRM');
  if (!['quote-one-post-read', 'reserve-one-post-read'].includes(action)) throw new Error('Confirmação operacional inválida.');
  const organizationId = required('TWITTER_CANARY_ORGANIZATION_ID');
  const admin = createSupabaseAdminClient();
  const [{ data: membership }, { data: candidates }, { data: walletBefore }, jobsBefore, itemsBefore, snapshotsBefore] = await Promise.all([
    admin.from('organization_members').select('user_id,role').eq('organization_id', organizationId).eq('role', 'admin').order('joined_at').limit(1).single(),
    admin.from('twitter_publication_items').select('id,execute_at').eq('organization_id', organizationId).eq('status', 'published').order('execute_at').limit(20),
    admin.from('twitter_wallets').select('posted_balance_micros,reserved_micros,version').eq('organization_id', organizationId).single(),
    admin.from('twitter_analytics_jobs').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId),
    admin.from('twitter_analytics_items').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId),
    admin.from('twitter_analytics_snapshots').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId),
  ]);
  if (!membership || membership.role !== 'admin' || !walletBefore) throw new Error('Admin ou carteira canário inválido.');
  if ((jobsBefore.count ?? 0) !== 0 || (itemsBefore.count ?? 0) !== 0 || (snapshotsBefore.count ?? 0) !== 0) throw new Error('Já existe estado de analytics X; não criar outro canário automaticamente.');
  if (Number(walletBefore.reserved_micros) !== 0) throw new Error('Carteira possui reserva antes do canário de analytics.');
  const candidateIds = (candidates ?? []).map((item) => item.id);
  const { data: publishedAttempts } = await admin.from('twitter_publication_attempts').select('item_id,post_id,status').in('item_id', candidateIds).eq('status', 'published').not('post_id', 'is', null);
  const candidate = (candidates ?? []).find((item) => publishedAttempts?.some((attempt) => attempt.item_id === item.id && attempt.post_id));
  if (!candidate) throw new Error('Nenhum post publicado elegível para analytics.');

  process.env.TWITTER_REVIEW_TOKEN_SECRET ??= randomBytes(32).toString('base64url');
  const request: TwitterAnalyticsRequest = { postIds: [candidate.id], profileIds: [] };
  const quote = await prepareTwitterAnalyticsQuote(organizationId, request);
  const walletQuote = quote.walletSnapshots[0];
  if (quote.resourceCount !== 1 || quote.postCount !== 1 || quote.profileCount !== 0 || quote.totalMicros !== 5_000 || !quote.canConfirm || quote.walletSnapshots.length !== 1 || walletQuote.analyticsCostMicros !== 5_000 || walletQuote.protectedFloorMicros !== 5_000_000 || walletQuote.projectedAvailableMicros < 5_000_000) throw new Error('Quote mínimo de analytics não atende às invariantes.');
  if (action === 'quote-one-post-read') {
    const { data: walletAfter } = await admin.from('twitter_wallets').select('posted_balance_micros,reserved_micros,version').eq('organization_id', organizationId).single();
    const safe = { action, candidateItemId: candidate.id, resourceCount: quote.resourceCount, totalMicros: quote.totalMicros, canConfirm: quote.canConfirm, walletBefore, walletAfter, projectedAvailableMicros: walletQuote.projectedAvailableMicros, protectedFloorMicros: walletQuote.protectedFloorMicros };
    if (JSON.stringify(walletAfter) !== JSON.stringify(walletBefore)) throw new Error(`Quote alterou carteira: ${JSON.stringify(safe)}`);
    process.stdout.write(`${JSON.stringify(safe, null, 2)}\n`); return;
  }

  const confirmed = await confirmTwitterAnalyticsQuote({ organizationId, actorUserId: membership.user_id, request, reviewToken: quote.reviewToken, idempotencyKey: `twitter-canary-analytics-${randomUUID()}` }) as Record<string, unknown>;
  const jobId = String(confirmed.jobId ?? '');
  const [{ data: job }, { data: items }, { data: reservations }, { data: walletAfter }, attemptsAfter, snapshotsAfter] = await Promise.all([
    admin.from('twitter_analytics_jobs').select('status,resource_count,reserved_micros').eq('id', jobId).single(),
    admin.from('twitter_analytics_items').select('id,status,resource_type,publication_item_id,category,amount_micros,attempt_count,zernio_post_id').eq('job_id', jobId),
    admin.from('twitter_wallet_reservations').select('status,origin,category,initial_micros,remaining_micros,settled_micros,released_micros').eq('source_id', jobId),
    admin.from('twitter_wallets').select('posted_balance_micros,reserved_micros,version').eq('organization_id', organizationId).single(),
    admin.from('twitter_analytics_attempts').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId),
    admin.from('twitter_analytics_snapshots').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId),
  ]);
  const item = items?.[0]; const reservation = reservations?.[0];
  const safe = { action, jobId, analyticsItemId: item?.id, candidateItemId: candidate.id, job, item: item ? { ...item, zernio_post_id: Boolean(item.zernio_post_id) } : null, reservation, walletBefore, walletAfter, attemptCount: attemptsAfter.count ?? 0, snapshotCount: snapshotsAfter.count ?? 0 };
  const valid = jobId && job?.status === 'reserved' && Number(job.resource_count) === 1 && Number(job.reserved_micros) === 5_000
    && items?.length === 1 && item?.status === 'reserved' && item.resource_type === 'post' && item.publication_item_id === candidate.id && item.category === 'post_read' && Number(item.amount_micros) === 5_000 && Number(item.attempt_count) === 0 && Boolean(item.zernio_post_id)
    && reservations?.length === 1 && reservation?.status === 'open' && reservation.origin === 'analytics' && reservation.category === 'post_read' && Number(reservation.initial_micros) === 5_000 && Number(reservation.remaining_micros) === 5_000 && Number(reservation.settled_micros) === 0 && Number(reservation.released_micros) === 0
    && Number(walletAfter?.posted_balance_micros) === Number(walletBefore.posted_balance_micros) && Number(walletAfter?.reserved_micros) === 5_000 && Number(walletAfter?.version) === Number(walletBefore.version) + 1
    && (attemptsAfter.count ?? 0) === 0 && (snapshotsAfter.count ?? 0) === 0;
  if (!valid) throw new Error(`Reserva de analytics não atende às invariantes: ${JSON.stringify(safe)}`);
  process.stdout.write(`${JSON.stringify(safe, null, 2)}\n`);
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : 'Falha desconhecida.'}\n`); process.exitCode = 1; });
