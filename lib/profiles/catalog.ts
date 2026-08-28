import type { SupabaseClient } from '@supabase/supabase-js';

export const INSTAGRAM_PROFILES_PAGE_SIZE = 40;
export const INSTAGRAM_PROFILES_MAX_PAGE_SIZE = 100;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type InstagramProfileStatus = 'no_data' | 'online' | 'offline' | 'reauthorization_required';
export type InstagramProfileSituation = 'all' | 'online' | 'error' | 'paused';
export type InstagramProfilePublicationFilter = 'all' | 'posted';

export type InstagramProfileAnalyticsSummary = {
  profile_id: string;
  scheduled_total: number;
  scheduled_reel: number;
  scheduled_story: number;
  scheduled_image: number;
  scheduled_carousel: number;
  published_total: number;
  published_reel: number;
  published_story: number;
  published_image: number;
  published_carousel: number;
  followers_count: number;
  followers_delta: number;
  views: number;
  reach: number;
  impressions: number;
  total_interactions: number;
  engagement_rate: number;
  posts_count: number;
  latest_published_at: string | null;
  analytics_status: 'pending' | 'synced' | 'partial' | 'no_data' | 'not_configured' | 'unavailable_plan' | 'permission_missing' | 'rate_limited' | 'failed';
  analytics_unavailable_reason: string | null;
  analytics_synced_at: string | null;
};

export type InstagramProfileCatalogItem = {
  id: string;
  username: string;
  display_name: string | null;
  profile_picture_url: string | null;
  account_type: string | null;
  status: InstagramProfileStatus;
  provider: 'meta_official' | 'zernio';
  zernio_account_id: string | null;
  zernio_connection_id: string | null;
  token_expires_at: string | null;
  last_checked_at: string | null;
  last_error_message: string | null;
  created_at: string;
  group_id: string | null;
  group_name: string | null;
  zernio_connection_label: string | null;
  publication_metrics: InstagramProfileAnalyticsSummary;
};

export type InstagramProfilesCatalogSummary = {
  total: number;
  online: number;
  error: number;
  paused: number;
  publishedItems: number;
  filteredTotal: number;
};

export type InstagramProfilesCatalogFilters = {
  query: string;
  groupId: string | null;
  status: 'all' | InstagramProfileStatus;
  situation: InstagramProfileSituation;
  publication: InstagramProfilePublicationFilter;
};

export type InstagramProfilesCatalogCursor = { createdAt: string; id: string };

export type InstagramProfilesCatalogPage = {
  items: InstagramProfileCatalogItem[];
  summary: InstagramProfilesCatalogSummary;
  hasMore: boolean;
  nextCursor: string | null;
  limit: number;
};

type CatalogRow = Omit<InstagramProfileCatalogItem, 'publication_metrics'> & InstagramProfileAnalyticsSummary & { has_more: boolean };
type SummaryRow = { total: number | string; online: number | string; error: number | string; paused: number | string; published_items: number | string; filtered_total: number | string };

export function encodeInstagramProfilesCursor(cursor: InstagramProfilesCatalogCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeInstagramProfilesCursor(value: string | null | undefined): InstagramProfilesCatalogCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<InstagramProfilesCatalogCursor>;
    if (typeof parsed.createdAt !== 'string' || !Number.isFinite(Date.parse(parsed.createdAt)) || typeof parsed.id !== 'string' || !UUID_PATTERN.test(parsed.id)) return null;
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    return null;
  }
}

export function normalizeInstagramProfilesLimit(value: number) {
  if (!Number.isInteger(value)) return INSTAGRAM_PROFILES_PAGE_SIZE;
  return Math.min(INSTAGRAM_PROFILES_MAX_PAGE_SIZE, Math.max(1, value));
}

export function normalizeInstagramProfilesFilters(input: Partial<InstagramProfilesCatalogFilters>): InstagramProfilesCatalogFilters {
  const query = typeof input.query === 'string' ? input.query.trim().slice(0, 120) : '';
  const groupId = typeof input.groupId === 'string' && UUID_PATTERN.test(input.groupId) ? input.groupId : null;
  const statuses = new Set(['no_data', 'online', 'offline', 'reauthorization_required']);
  const situations = new Set(['all', 'online', 'error', 'paused']);
  return {
    query,
    groupId,
    status: typeof input.status === 'string' && statuses.has(input.status) ? input.status as InstagramProfileStatus : 'all',
    situation: typeof input.situation === 'string' && situations.has(input.situation) ? input.situation as InstagramProfileSituation : 'all',
    publication: input.publication === 'posted' ? 'posted' : 'all',
  };
}

function mapCatalogRow(row: CatalogRow): InstagramProfileCatalogItem {
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    profile_picture_url: row.profile_picture_url,
    account_type: row.account_type,
    status: row.status,
    provider: row.provider,
    zernio_account_id: row.zernio_account_id,
    zernio_connection_id: row.zernio_connection_id,
    token_expires_at: row.token_expires_at,
    last_checked_at: row.last_checked_at,
    last_error_message: row.last_error_message,
    created_at: row.created_at,
    group_id: row.group_id,
    group_name: row.group_name,
    zernio_connection_label: row.zernio_connection_label,
    publication_metrics: {
      profile_id: row.id,
      scheduled_total: row.scheduled_total,
      scheduled_reel: row.scheduled_reel,
      scheduled_story: row.scheduled_story,
      scheduled_image: row.scheduled_image,
      scheduled_carousel: row.scheduled_carousel,
      published_total: row.published_total,
      published_reel: row.published_reel,
      published_story: row.published_story,
      published_image: row.published_image,
      published_carousel: row.published_carousel,
      followers_count: Number(row.followers_count),
      followers_delta: Number(row.followers_delta),
      views: Number(row.views),
      reach: Number(row.reach),
      impressions: Number(row.impressions),
      total_interactions: Number(row.total_interactions),
      engagement_rate: Number(row.engagement_rate),
      posts_count: row.posts_count,
      latest_published_at: row.latest_published_at,
      analytics_status: row.analytics_status,
      analytics_unavailable_reason: row.analytics_unavailable_reason,
      analytics_synced_at: row.analytics_synced_at,
    },
  };
}

export async function getInstagramProfilesCatalogPage(input: {
  supabase: SupabaseClient;
  organizationId: string;
  filters?: Partial<InstagramProfilesCatalogFilters>;
  cursor?: InstagramProfilesCatalogCursor | null;
  limit?: number;
}): Promise<InstagramProfilesCatalogPage> {
  const filters = normalizeInstagramProfilesFilters(input.filters ?? {});
  const limit = normalizeInstagramProfilesLimit(input.limit ?? INSTAGRAM_PROFILES_PAGE_SIZE);
  const rpcFilters = {
    p_organization_id: input.organizationId,
    p_query: filters.query || null,
    p_group_id: filters.groupId,
    p_status: filters.status === 'all' ? null : filters.status,
    p_situation: filters.situation === 'all' ? null : filters.situation,
    p_publication: filters.publication,
  };
  const [pageResult, summaryResult] = await Promise.all([
    input.supabase.rpc('list_instagram_profiles_catalog_page', {
      ...rpcFilters,
      p_limit: limit,
      p_cursor_created_at: input.cursor?.createdAt ?? null,
      p_cursor_id: input.cursor?.id ?? null,
    }),
    input.supabase.rpc('get_instagram_profiles_catalog_summary', rpcFilters),
  ]);
  if (pageResult.error) throw new Error(`profiles_catalog_page:${pageResult.error.message}`);
  if (summaryResult.error) throw new Error(`profiles_catalog_summary:${summaryResult.error.message}`);

  const rows = (pageResult.data ?? []) as CatalogRow[];
  const summaryRow = ((summaryResult.data ?? []) as SummaryRow[])[0];
  const last = rows.at(-1);
  const hasMore = Boolean(rows[0]?.has_more);
  return {
    items: rows.map(mapCatalogRow),
    summary: {
      total: Number(summaryRow?.total ?? 0),
      online: Number(summaryRow?.online ?? 0),
      error: Number(summaryRow?.error ?? 0),
      paused: Number(summaryRow?.paused ?? 0),
      publishedItems: Number(summaryRow?.published_items ?? 0),
      filteredTotal: Number(summaryRow?.filtered_total ?? 0),
    },
    hasMore,
    nextCursor: hasMore && last ? encodeInstagramProfilesCursor({ createdAt: last.created_at, id: last.id }) : null,
    limit,
  };
}
