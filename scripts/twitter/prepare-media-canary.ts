import { randomBytes, randomUUID } from 'node:crypto';

import { createSupabaseAdminClient } from '../../lib/supabase/admin';
import { confirmTwitterBulkReview, prepareTwitterBulkReview, type TwitterBulkRequest } from '../../lib/twitter/bulk-service';

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

async function main() {
  if (required('TWITTER_CANARY_CONFIRM') !== 'prepare-one-media-post') throw new Error('Confirmação operacional inválida.');
  const organizationId = required('TWITTER_CANARY_ORGANIZATION_ID');
  const assetIds = required('TWITTER_CANARY_ASSET_IDS').split(',').map((value) => value.trim()).filter(Boolean);
  const setKind = required('TWITTER_CANARY_MEDIA_SET_KIND') as 'images' | 'gif' | 'video';
  const delayMinutes = Number(process.env.TWITTER_CANARY_DELAY_MINUTES ?? '20');
  if (!['images', 'gif', 'video'].includes(setKind)) throw new Error('Tipo de conjunto inválido.');
  if (!Number.isInteger(delayMinutes) || delayMinutes < 10 || delayMinutes > 60) throw new Error('Delay deve ficar entre 10 e 60 minutos.');
  if ((setKind === 'images' && (assetIds.length < 1 || assetIds.length > 4)) || (setKind !== 'images' && assetIds.length !== 1)) throw new Error('Quantidade de assets inválida.');
  const admin = createSupabaseAdminClient();
  const [{ data: membership }, { data: profiles }, { data: assets }, nonterminal] = await Promise.all([
    admin.from('organization_members').select('user_id, role').eq('organization_id', organizationId).eq('role', 'admin').order('joined_at').limit(1).single(),
    admin.from('twitter_profiles').select('id').eq('organization_id', organizationId).is('deleted_at', null).eq('status', 'active').eq('can_post', true),
    admin.from('twitter_media_assets').select('id, media_kind, status').eq('organization_id', organizationId).in('id', assetIds).is('deleted_at', null),
    admin.from('twitter_publication_items').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).in('status', ['ready', 'claimed', 'retry', 'outcome_unknown']),
  ]);
  if (!membership || membership.role !== 'admin' || profiles?.length !== 1) throw new Error('Admin/perfil canário inválido.');
  if ((nonterminal.count ?? 0) !== 0) throw new Error('Existe item X não terminal; não criar outro canário.');
  const expectedKind = setKind === 'images' ? 'image' : setKind;
  if (assets?.length !== assetIds.length || assets.some((asset) => asset.status !== 'ready' || asset.media_kind !== expectedKind)) throw new Error('Assets canário não estão prontos ou não correspondem ao tipo.');

  process.env.TWITTER_REVIEW_TOKEN_SECRET ??= randomBytes(32).toString('base64url');
  const executeAt = new Date(Date.now() + delayMinutes * 60_000); executeAt.setUTCSeconds(0, 0);
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const request: TwitterBulkRequest = {
    scheduleVersion: 2,
    name: `Canário de mídia ${setKind}`,
    profileIds: [profiles[0].id],
    texts: [`Canário técnico Athena X — teste isolado ${setKind} ${stamp}`],
    mediaSets: [{ clientKey: `canary-${randomUUID()}`, mediaKind: setKind, assetIds }],
    schedule: { kind: 'interval', intervalMinutes: 1440, durationDays: 1 },
  };
  const review = await prepareTwitterBulkReview(organizationId, request);
  if (review.totalRequested !== 1 || review.fundedCount !== 1 || review.unfundedCount !== 0 || review.reservedMicros !== 15_000 || review.items[0]?.media_set_client_key == null) throw new Error('Revisão de mídia não produziu um slot de 15.000 micros.');
  const confirmed = await confirmTwitterBulkReview({ organizationId, actorUserId: membership.user_id, request, reviewToken: review.reviewToken, idempotencyKey: `twitter-canary-${setKind}-${randomUUID()}` }) as Record<string, unknown>;
  const programId = String(confirmed.programId ?? '');
  const { data: items } = await admin.from('twitter_publication_items').select('id,status,execute_at,category,amount_micros,attempt_count,media_set_client_key').eq('program_id', programId);
  const { data: wallet } = await admin.from('twitter_wallets').select('posted_balance_micros,reserved_micros,version').eq('organization_id', organizationId).single();
  const item = items?.[0];
  const safe = { programId, itemId: item?.id, setKind, assetCount: assetIds.length, item, wallet };
  if (!programId || items?.length !== 1 || item?.status !== 'ready' || item?.category !== 'post_dm_create' || Number(item?.amount_micros) !== 15_000 || Number(item?.attempt_count) !== 0 || !item?.media_set_client_key || Number(wallet?.reserved_micros) !== 15_000) throw new Error(`Invariantes pós-confirmação não atendidas: ${JSON.stringify(safe)}`);
  process.stdout.write(`${JSON.stringify(safe, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Falha desconhecida.'}\n`);
  process.exitCode = 1;
});
