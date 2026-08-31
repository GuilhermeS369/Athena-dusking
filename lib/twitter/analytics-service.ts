import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { fetchAllRowsByIds } from '@/lib/supabase/chunk';

import {
  TWITTER_ANALYTICS_POST_READ_RESERVE_UNITS,
  TWITTER_ANALYTICS_PROFILE_READ_RESERVE_UNITS,
  twitterAnalyticsReservedAmountMicros,
  twitterAnalyticsWalletProjection,
} from './analytics-pricing';
import { signTwitterReviewToken, twitterReviewDigest, verifyTwitterReviewToken } from './review-token';

export type TwitterAnalyticsCollectionStage = 'followers_daily' | 'd1' | 'd7' | 'd30' | 'forced';
export type TwitterAnalyticsTarget = {
  resourceType: 'post' | 'profile';
  resourceId: string;
  stage: TwitterAnalyticsCollectionStage;
  requestedFrom?: string;
  requestedTo?: string;
  force?: boolean;
};

/** Legacy requests remain available for rollout canaries and mean forced reads. */
export type TwitterAnalyticsRequest =
  | { version: 2; targets: TwitterAnalyticsTarget[] }
  | { postIds: string[]; profileIds: string[] };

type RequiredTarget = {
  resourceType: 'post' | 'profile'; resourceId: string;
  stage: TwitterAnalyticsCollectionStage;
  requestedFrom: string | null; requestedTo: string | null; force: boolean;
};
type CanonicalRequest = { version: 2; targets: RequiredTarget[] };
type ResolvedResource = RequiredTarget & {
  identityId: string; connectionId: string; profileId: string;
  amountMicros: number; collectionKey: string;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isTwitterAnalyticsRequest(value: unknown): value is TwitterAnalyticsRequest {
  if (!value || typeof value !== 'object') return false;
  const input = value as Record<string, unknown>;
  if (input.version === 2) {
    return Array.isArray(input.targets) && input.targets.every((target) => {
      if (!target || typeof target !== 'object') return false;
      const item = target as Record<string, unknown>;
      return ['post', 'profile'].includes(String(item.resourceType))
        && typeof item.resourceId === 'string' && UUID_RE.test(item.resourceId)
        && ['followers_daily', 'd1', 'd7', 'd30', 'forced'].includes(String(item.stage))
        && (item.requestedFrom === undefined || typeof item.requestedFrom === 'string' && DATE_RE.test(item.requestedFrom))
        && (item.requestedTo === undefined || typeof item.requestedTo === 'string' && DATE_RE.test(item.requestedTo))
        && (item.force === undefined || typeof item.force === 'boolean');
    });
  }
  return Array.isArray(input.postIds) && input.postIds.every((id) => typeof id === 'string' && UUID_RE.test(id))
    && Array.isArray(input.profileIds) && input.profileIds.every((id) => typeof id === 'string' && UUID_RE.test(id));
}

function canonical(input: TwitterAnalyticsRequest): CanonicalRequest {
  const raw: TwitterAnalyticsTarget[] = 'targets' in input ? input.targets : [
    ...input.postIds.map((resourceId) => ({ resourceType: 'post' as const, resourceId, stage: 'forced' as const, force: true })),
    ...input.profileIds.map((resourceId) => ({ resourceType: 'profile' as const, resourceId, stage: 'forced' as const, force: true })),
  ];
  const unique = new Map<string, RequiredTarget>();
  for (const target of raw) {
    const force = target.force === true || target.stage === 'forced';
    if (target.resourceType === 'profile' && !force && target.stage !== 'followers_daily') throw new Error('Perfil X aceita somente coleta diária de followers.');
    if (target.resourceType === 'post' && !force && target.stage === 'followers_daily') throw new Error('Estágio de coleta inválido para post X.');
    if (target.requestedFrom && target.requestedTo && target.requestedFrom > target.requestedTo) throw new Error('Período de analytics inválido.');
    const normalized: RequiredTarget = {
      resourceType: target.resourceType, resourceId: target.resourceId,
      stage: force ? 'forced' : target.stage,
      requestedFrom: target.requestedFrom ?? null,
      requestedTo: target.requestedTo ?? null, force,
    };
    const key = [normalized.resourceType, normalized.resourceId, normalized.stage, normalized.requestedFrom, normalized.requestedTo, normalized.force].join(':');
    unique.set(key, normalized);
  }
  return { version: 2, targets: [...unique.values()].sort((a, b) => `${a.resourceType}:${a.resourceId}:${a.stage}`.localeCompare(`${b.resourceType}:${b.resourceId}:${b.stage}`)) };
}

function collectionKey(target: RequiredTarget) {
  const scope = target.resourceType === 'profile'
    ? `${target.requestedFrom ?? 'auto'}:${target.requestedTo ?? 'auto'}`
    : target.stage;
  return `${target.resourceType}:${target.resourceId}:${scope}`;
}

export async function prepareTwitterAnalyticsQuote(organizationId: string, input: TwitterAnalyticsRequest) {
  const request = canonical(input);
  if (request.targets.length < 1 || request.targets.length > 1000) throw new Error('Selecione entre 1 e 1.000 recursos.');
  const admin = createSupabaseAdminClient();
  const { data: card, error: cardError } = await admin.from('twitter_rate_cards').select('id,version').eq('active', true).single();
  if (cardError || !card) throw new Error('Tabela de preços X indisponível.');
  const { data: rates } = await admin.from('twitter_cost_rates').select('category,unit_cost_micros').eq('rate_card_id', card.id);
  const postCost = Number(rates?.find((rate) => rate.category === 'post_read')?.unit_cost_micros ?? 0);
  const profileCost = Number(rates?.find((rate) => rate.category === 'user_read_follow_article')?.unit_cost_micros ?? 0);
  if (postCost !== 5_000 || profileCost !== 10_000) throw new Error('Tabela de preços X inesperada.');

  const postTargets = request.targets.filter((target) => target.resourceType === 'post');
  const profileTargets = request.targets.filter((target) => target.resourceType === 'profile');
  const postIds = [...new Set(postTargets.map((target) => target.resourceId))];
  const directProfileIds = [...new Set(profileTargets.map((target) => target.resourceId))];
  // A cota de targets é 1.000, mas postIds e directProfileIds são listas
  // independentes: a união abaixo chega perto de 2.000 e era truncada pelo teto
  // do PostgREST, fazendo a guarda de comprimento recusar a análise.
  const { data: items } = await fetchAllRowsByIds(postIds, (chunk, from, to) => admin.from('twitter_publication_items').select('id,identity_id,connection_id,profile_id,status').eq('organization_id', organizationId).in('id', chunk).eq('status', 'published').order('id', { ascending: true }).range(from, to));
  if (items.length !== postIds.length) throw new Error('Há posts indisponíveis para análise.');
  const allProfileIds = [...new Set([...directProfileIds, ...items.map((item) => item.profile_id)])];
  const { data: profiles } = await fetchAllRowsByIds(allProfileIds, (chunk, from, to) => admin.from('twitter_profiles').select('id,current_epoch_id,current_connection_id,can_fetch_analytics,analytics_enabled').eq('organization_id', organizationId).in('id', chunk).is('deleted_at', null).order('id', { ascending: true }).range(from, to));
  if (profiles.length !== allProfileIds.length) throw new Error('Há perfis indisponíveis para análise.');
  const connectionIds = [...new Set([...items.map((item) => item.connection_id), ...profiles.map((profile) => profile.current_connection_id).filter((id): id is string => Boolean(id))])];
  const { data: connections } = await fetchAllRowsByIds(connectionIds, (chunk, from, to) => admin.from('twitter_connections').select('id,identity_id,analytics_enabled,status').eq('organization_id', organizationId).in('id', chunk).is('deleted_at', null).order('id', { ascending: true }).range(from, to));
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const connectionById = new Map(connections.map((connection) => [connection.id, connection]));
  const resources: ResolvedResource[] = [];

  if (postIds.length) {
    // Relação 1:N — até 1.000 itens com várias tentativas cada. Truncado, o
    // .some() abaixo passava a acusar "Post sem ID Zernio confirmado" em posts
    // que tinham ID. Ordem por id (chave primária) para paginar com segurança.
    const { data: attempts } = await fetchAllRowsByIds(postIds, (chunk, from, to) => admin.from('twitter_publication_attempts').select('item_id,post_id,status,created_at').in('item_id', chunk).eq('status', 'published').not('post_id', 'is', null).order('id', { ascending: true }).range(from, to));
    for (const target of postTargets) {
      const item = items.find((candidate) => candidate.id === target.resourceId);
      const profile = item ? profileById.get(item.profile_id) : null;
      const connection = item ? connectionById.get(item.connection_id) : null;
      if (!item || !attempts.some((attempt) => attempt.item_id === item.id && attempt.post_id)) throw new Error('Post sem ID Zernio confirmado.');
      if (!profile?.analytics_enabled || !profile.can_fetch_analytics || !connection?.analytics_enabled) throw Object.assign(new Error('O post pertence a um perfil com Analytics desabilitado ou indisponível.'), { status: 409 });
      resources.push({ ...target, identityId: item.identity_id, connectionId: item.connection_id, profileId: item.profile_id, amountMicros: twitterAnalyticsReservedAmountMicros('post', postCost).amountMicros, collectionKey: collectionKey(target) });
    }
  }
  for (const target of profileTargets) {
    const profile = profileById.get(target.resourceId);
    const connection = profile?.current_connection_id ? connectionById.get(profile.current_connection_id) : null;
    if (!profile || !profile.current_epoch_id || !connection) throw new Error('Perfil sem conexão X ativa.');
    if (!profile.analytics_enabled || !profile.can_fetch_analytics || !connection.analytics_enabled) throw Object.assign(new Error('O perfil está com Analytics desabilitado ou indisponível.'), { status: 409 });
    resources.push({ ...target, identityId: connection.identity_id, connectionId: connection.id, profileId: profile.id, amountMicros: twitterAnalyticsReservedAmountMicros('profile', profileCost).amountMicros, collectionKey: collectionKey(target) });
  }

  const identities = [...new Set(resources.map((resource) => resource.identityId))];
  // Mesma paginação por blocos das quatro leituras acima: a cota de 1.000
  // targets pode render perto de 2.000 identidades distintas, e um .in() dessa
  // largura estoura a query string antes mesmo do teto de linhas. A carteira é
  // 1 linha por identidade, então a comparação de comprimento abaixo só é
  // confiável se nenhuma resposta vier cortada.
  const { data: wallets } = await fetchAllRowsByIds(identities, (chunk, from, to) => admin.from('twitter_wallets').select('identity_id,posted_balance_micros,reserved_micros,version').eq('organization_id', organizationId).in('identity_id', chunk).order('identity_id', { ascending: true }).range(from, to));
  if (wallets?.length !== identities.length) throw new Error('Carteira X indisponível.');
  const walletSnapshots = wallets.map((wallet) => {
    const analyticsCostMicros = resources.filter((resource) => resource.identityId === wallet.identity_id).reduce((sum, resource) => sum + resource.amountMicros, 0);
    const postedBalanceMicros = Number(wallet.posted_balance_micros), reservedMicros = Number(wallet.reserved_micros);
    return { identityId: wallet.identity_id, postedBalanceMicros, reservedMicros, analyticsCostMicros, walletVersion: Number(wallet.version), ...twitterAnalyticsWalletProjection({ postedBalanceMicros, reservedMicros, analyticsCostMicros }) };
  });
  const totalMicros = resources.reduce((sum, resource) => sum + resource.amountMicros, 0);
  const digest = twitterReviewDigest({ organizationId, request, rateCardVersion: card.version, walletSnapshots });
  const reviewToken = signTwitterReviewToken({ kind: 'twitter-analytics', organizationId, requestDigest: twitterReviewDigest(request), quoteDigest: digest, rateCardVersion: card.version, walletSnapshots, expiresAt: Date.now() + 10 * 60_000 });
  return {
    request, reviewToken, quoteDigest: digest, rateCardVersion: card.version,
    resourceCount: resources.length, postCount: postTargets.length, profileCount: profileTargets.length,
    forcedCount: resources.filter((resource) => resource.force).length, reusedCount: 0, totalMicros,
    postReadUnitMicros: postCost, postReadReserveUnits: TWITTER_ANALYTICS_POST_READ_RESERVE_UNITS,
    postReadMaximumMicros: postCost * TWITTER_ANALYTICS_POST_READ_RESERVE_UNITS,
    profileReadUnitMicros: profileCost, profileReadReserveUnits: TWITTER_ANALYTICS_PROFILE_READ_RESERVE_UNITS,
    walletSnapshots, canConfirm: walletSnapshots.every((wallet) => wallet.canFund),
  };
}

export async function confirmTwitterAnalyticsQuote(input: { organizationId: string; actorUserId: string; request: TwitterAnalyticsRequest; reviewToken: string; idempotencyKey: string }) {
  const request = canonical(input.request);
  const token = verifyTwitterReviewToken(input.reviewToken) as { kind?: unknown; organizationId?: unknown; requestDigest?: unknown; quoteDigest?: string; rateCardVersion?: number; walletSnapshots?: unknown };
  if (token.kind !== 'twitter-analytics' || token.organizationId !== input.organizationId || token.requestDigest !== twitterReviewDigest(request) || typeof token.quoteDigest !== 'string' || typeof token.rateCardVersion !== 'number' || !Array.isArray(token.walletSnapshots)) throw Object.assign(new Error('Revisão de analytics divergente.'), { status: 409 });
  const resources = request.targets.map((target) => ({ type: target.resourceType, id: target.resourceId, collectionKey: collectionKey(target), collectionStage: target.stage, requestedFrom: target.requestedFrom, requestedTo: target.requestedTo, forceRefresh: target.force }));
  const { data, error } = await createSupabaseAdminClient().rpc('twitter_confirm_analytics_job', {
    p_organization_id: input.organizationId, p_actor_user_id: input.actorUserId,
    p_idempotency_key: input.idempotencyKey, p_quote_digest: token.quoteDigest,
    p_rate_card_version: token.rateCardVersion, p_wallet_snapshots: token.walletSnapshots,
    p_resources: resources,
  });
  if (error) {
    const stale = error.code === '40001' || /revise|coletad|duplicad|capability|Analytics desabilitado/i.test(error.message);
    throw Object.assign(new Error(stale ? 'Seleção, saldo ou disponibilidade mudaram; revise novamente.' : error.message), { status: stale ? 409 : 400 });
  }
  return data;
}
