import { decryptToken } from '@/lib/security/token-crypto';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export type ZernioAccount = {
  _id?: string;
  accountId?: string;
  id?: string;
  platform?: string;
  username?: string;
  displayName?: string;
  profilePicture?: string | null;
  profilePictureUrl?: string | null;
  avatarUrl?: string | null;
  avatar?: string | null;
  picture?: string | null;
  profileImage?: string | null;
  profileImageUrl?: string | null;
  profileUrl?: string;
  followersCount?: number;
  followersLastUpdated?: string;
  followerCount?: number;
  profileData?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  isActive?: boolean;
  profileId?: string | { _id?: string; name?: string };
  [key: string]: unknown;
};

export type ZernioPost = {
  _id?: string;
  id?: string;
  status?: string;
  content?: string;
  scheduledFor?: string;
  publishedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  thumbnailUrl?: string | null;
  mediaType?: string | null;
  mediaItems?: Array<Record<string, unknown>>;
  platformPostUrl?: string;
  platforms?: Array<{
    platform?: string;
    status?: string;
    platformPostUrl?: string;
    error?: string;
    failureReason?: string;
    accountId?: string | ZernioAccount;
    platformSpecificData?: Record<string, unknown>;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
};

export type ZernioAnalyticsMetrics = {
  impressions?: number;
  reach?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  clicks?: number;
  views?: number;
  follows?: number;
  engagementRate?: number;
  lastUpdated?: string;
  [key: string]: unknown;
};

export type ZernioAnalyticsPost = {
  _id?: string;
  id?: string;
  postId?: string;
  latePostId?: string | null;
  platformPostId?: string | null;
  platformPostUrl?: string | null;
  status?: string;
  content?: string;
  publishedAt?: string | null;
  scheduledFor?: string | null;
  thumbnailUrl?: string | null;
  mediaType?: string | null;
  isExternal?: boolean;
  analytics?: ZernioAnalyticsMetrics;
  platformAnalytics?: Array<{
    platform?: string;
    accountId?: string;
    accountUsername?: string | null;
    status?: string;
    platformPostId?: string | null;
    platformPostUrl?: string | null;
    analytics?: ZernioAnalyticsMetrics;
    syncStatus?: string;
    errorMessage?: string | null;
  }>;
  [key: string]: unknown;
};

export type ZernioAnalyticsListResponse = {
  overview?: Record<string, unknown>;
  posts?: ZernioAnalyticsPost[];
  pagination?: { page?: number; limit?: number; total?: number; pages?: number };
  accounts?: Array<Record<string, unknown>>;
  hasAnalyticsAccess?: boolean;
};

export type ZernioDailyMetricsResponse = {
  dailyData?: Array<{
    date?: string;
    postCount?: number;
    platforms?: Record<string, number>;
    metrics?: {
      impressions?: number;
      reach?: number;
      likes?: number;
      comments?: number;
      shares?: number;
      saves?: number;
      clicks?: number;
      views?: number;
      [key: string]: unknown;
    };
  }>;
  platformBreakdown?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

export type ZernioInstagramAccountInsightsResponse = {
  success?: boolean;
  accountId?: string;
  platform?: string;
  dateRange?: { since?: string; until?: string };
  metricType?: 'time_series' | 'total_value';
  metrics?: Record<string, { total?: number; values?: Array<{ date?: string; value?: number }>; breakdowns?: Array<{ dimension?: string; value?: number }> }>;
  unavailableMetrics?: Array<{ metric?: string; reason?: string; message?: string }>;
  dataDelay?: string;
  [key: string]: unknown;
};

export type ZernioFollowerHistoryResponse = {
  accountId?: string;
  followers?: Array<Record<string, unknown>>;
  history?: Array<Record<string, unknown>>;
  dailyData?: Array<Record<string, unknown>>;
  data?: Array<Record<string, unknown>>;
  metrics?: ZernioInstagramAccountInsightsResponse['metrics'];
  dateRange?: ZernioInstagramAccountInsightsResponse['dateRange'];
  metricType?: ZernioInstagramAccountInsightsResponse['metricType'];
  unavailableMetrics?: ZernioInstagramAccountInsightsResponse['unavailableMetrics'];
  [key: string]: unknown;
};

export type ZernioInstagramDemographicsResponse = {
  success?: boolean;
  accountId?: string;
  platform?: string;
  metric?: 'follower_demographics' | 'engaged_audience_demographics';
  timeframe?: 'this_week' | 'this_month';
  demographics?: Record<string, unknown>;
  note?: string;
  [key: string]: unknown;
};

export type ZernioFollowerStatsResponse = {
  accounts?: Array<Record<string, unknown>>;
  stats?: Record<string, unknown>;
  dateRange?: { from?: string; to?: string };
  granularity?: string;
  [key: string]: unknown;
};

export type ZernioBillingResponse = {
  plan?: Record<string, unknown>;
  cycle?: Record<string, unknown>;
  balance?: {
    creditsRemainingCents?: number;
    accruedThisPeriodCents?: number;
    currency?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

type ZernioRequestOptions = {
  method?: 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT';
  query?: Record<string, string | boolean | number | null | undefined>;
  body?: unknown;
  requestId?: string;
  idempotencyKey?: string;
};

export type ZernioClient = ReturnType<typeof createZernioClient>;

export type ZernioError = Error & {
  code?: string;
  httpStatus?: number;
  reason?: string | null;
  retryable?: boolean;
  details?: unknown;
  requestId?: string | null;
  existingPostId?: string | null;
};

export type ZernioConnectionRecord = {
  id: string;
  organization_id: string;
  label: string;
  encrypted_api_key: string;
  zernio_profile_id: string | null;
  status: 'no_data' | 'online' | 'offline' | 'reauthorization_required';
  metadata?: Record<string, unknown> | null;
  instagram_slot_limit?: number | null;
};

const zernioBaseUrl = process.env.ZERNIO_API_BASE_URL ?? 'https://zernio.com/api';
const configuredZernioTimeout = Number.parseInt(process.env.ZERNIO_REQUEST_TIMEOUT_MS ?? '', 10);
const zernioRequestTimeoutMs = Number.isInteger(configuredZernioTimeout)
  ? Math.min(Math.max(configuredZernioTimeout, 25_000), 90_000)
  : 45_000;

function zernioUrl(path: string, query?: ZernioRequestOptions['query']) {
  const url = new URL(`${zernioBaseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }
  return url;
}

async function readZernioResponse(response: Response) {
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const bodyError = body.error && typeof body.error === 'object' && !Array.isArray(body.error)
      ? body.error as Record<string, unknown>
      : null;
    const message = typeof body.message === 'string'
      ? body.message
      : typeof body.error === 'string'
        ? body.error
        : typeof bodyError?.message === 'string'
          ? bodyError.message
          : `Zernio retornou HTTP ${response.status}.`;
    const code = [body.code, bodyError?.code, body.reason, bodyError?.reason]
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
    const reason = [body.reason, bodyError?.reason]
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0) ?? null;
    const error = new Error(message) as ZernioError;
    error.code = code ?? String(response.status);
    error.httpStatus = response.status;
    error.reason = reason;
    error.retryable = response.status === 429 || response.status >= 500;
    error.details = body.details ?? bodyError?.details;
    const details = error.details && typeof error.details === 'object' && !Array.isArray(error.details)
      ? error.details as Record<string, unknown>
      : null;
    error.existingPostId = [body.existingPostId, details?.existingPostId, bodyError?.existingPostId]
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0) ?? null;
    error.requestId = response.headers.get('x-request-id') ?? response.headers.get('x-vercel-id');
    throw error;
  }
  return body;
}

export function isZernioAuthenticationError(error: unknown) {
  if (isZernioPlanLimitError(error)) return false;
  const code = (error as ZernioError | undefined)?.code;
  return code === '401' || code === '403' || code === 'unauthorized' || code === 'forbidden';
}

export function isZernioPlanLimitError(error: unknown) {
  const typed = error as ZernioError | undefined;
  const normalizedCode = String(typed?.code ?? '').trim().toUpperCase();
  const normalizedReason = String(typed?.reason ?? '').trim().toUpperCase();
  if (typed?.httpStatus === 402 || normalizedCode === '402' || normalizedCode === 'PAYMENT_REQUIRED' || normalizedReason === 'PAYMENT_REQUIRED') return true;

  const value = `${normalizedCode} ${normalizedReason} ${typed?.message ?? ''} ${JSON.stringify(typed?.details ?? {})}`.toLowerCase();
  return value.includes('payment_required')
    || value.includes('payment')
    || value.includes('billing')
    || value.includes('plan')
    || value.includes('limit')
    || value.includes('quota')
    || value.includes('upgrade')
    || value.includes('subscription')
    || value.includes('forma de pagamento');
}

export function createZernioClient(apiKey: string) {
  if (!apiKey.trim()) throw new Error('Chave da Zernio vazia.');

  async function request(path: string, options: ZernioRequestOptions = {}) {
    const response = await fetch(zernioUrl(path, options.query), {
      method: options.method ?? (options.body ? 'POST' : 'GET'),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.requestId ? { 'x-request-id': options.requestId } : {}),
        ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(zernioRequestTimeoutMs),
    });
    return readZernioResponse(response);
  }

  return {
    async listProfiles(query: { name?: string; includeOverLimit?: boolean } = {}) {
      return request('/v1/profiles', { query }) as Promise<{
        profiles?: Array<{ _id?: string; id?: string; name?: string; isDefault?: boolean; isOverLimit?: boolean }>;
      }>;
    },
    async createProfile(name: string, idempotencyKey?: string) {
      return request('/v1/profiles', { body: { name }, idempotencyKey }) as Promise<{
        profile?: { _id?: string; id?: string; name?: string };
      }>;
    },
    async deleteProfile(profileId: string) {
      return request(`/v1/profiles/${encodeURIComponent(profileId)}`, { method: 'DELETE' }) as Promise<{ message?: string }>;
    },
    async startConnect(platform: 'instagram', profileId: string, redirectUrl: string) {
      return request(`/v1/connect/${platform}`, { query: { profileId, redirect_url: redirectUrl } }) as Promise<{ authUrl?: string; state?: string }>;
    },
    async listAccounts() {
      return request('/v1/accounts') as Promise<{ accounts?: ZernioAccount[] }>;
    },
    async accountsHealth() {
      return request('/v1/accounts/health') as Promise<{ accounts?: Array<ZernioAccount & { accountId?: string; status?: string; canPost?: boolean; issues?: unknown[] }> }>;
    },
    async getBilling() {
      return request('/v1/billing') as Promise<ZernioBillingResponse>;
    },
    async createPost(body: unknown, requestId: string) {
      return request('/v1/posts', { body, requestId }) as Promise<{ post?: ZernioPost; existingPost?: ZernioPost; message?: string }>;
    },
    async getPost(postId: string) {
      return request(`/v1/posts/${encodeURIComponent(postId)}`) as Promise<{ post?: ZernioPost }>;
    },
    async listPosts(query: {
      limit?: number;
      page?: number;
      source?: 'zernio' | 'external' | 'all';
      status?: string;
      platform?: string;
      profileId?: string;
      accountId?: string;
      dateFrom?: string;
      dateTo?: string;
      sortBy?: string;
      search?: string;
    } = {}) {
      return request('/v1/posts', { query }) as Promise<{ posts?: ZernioPost[]; pagination?: { page?: number; limit?: number; total?: number; pages?: number } }>;
    },
    async getAnalytics(query: {
      postId?: string;
      platform?: string;
      profileId?: string;
      accountId?: string;
      source?: 'late' | 'external' | 'all';
      fromDate?: string;
      toDate?: string;
      limit?: number;
      page?: number;
      sortBy?: string;
      order?: 'asc' | 'desc';
    } = {}) {
      return request('/v1/analytics', { query }) as Promise<ZernioAnalyticsListResponse | ZernioAnalyticsPost>;
    },
    async getInstagramAccountInsights(query: {
      accountId: string;
      metrics?: string;
      since?: string;
      until?: string;
      metricType?: 'total_value' | 'time_series';
      breakdown?: string;
    }) {
      return request('/v1/analytics/instagram/account-insights', { query }) as Promise<ZernioInstagramAccountInsightsResponse>;
    },
    async getInstagramFollowerHistory(query: {
      accountId: string;
      metrics?: string;
      since?: string;
      until?: string;
      metricType?: 'total_value' | 'time_series';
    }) {
      return request('/v1/analytics/instagram/follower-history', { query }) as Promise<ZernioFollowerHistoryResponse>;
    },
    async getFollowerStats(query: {
      accountIds?: string;
      profileId?: string;
      fromDate?: string;
      toDate?: string;
      granularity?: 'daily' | 'weekly' | 'monthly' | string;
    } = {}) {
      return request('/v1/accounts/follower-stats', { query }) as Promise<ZernioFollowerStatsResponse>;
    },
    async getInstagramDemographics(query: {
      accountId: string;
      metric?: 'follower_demographics' | 'engaged_audience_demographics';
      breakdown?: string;
      timeframe?: 'this_week' | 'this_month';
    }) {
      return request('/v1/analytics/instagram/demographics', { query }) as Promise<ZernioInstagramDemographicsResponse>;
    },
    async getDailyMetrics(query: {
      platform?: string;
      profileId?: string;
      accountId?: string;
      fromDate?: string;
      toDate?: string;
      source?: 'late' | 'external' | 'all';
      attribution?: 'publish' | 'received';
    } = {}) {
      return request('/v1/analytics/daily-metrics', { query }) as Promise<ZernioDailyMetricsResponse>;
    },
    async getBestTime(query: { platform?: string; profileId?: string; accountId?: string; source?: 'late' | 'external' | 'all' } = {}) {
      return request('/v1/analytics/best-time', { query }) as Promise<Record<string, unknown>>;
    },
    async getContentDecay(query: { platform?: string; profileId?: string; accountId?: string; source?: 'late' | 'external' | 'all' } = {}) {
      return request('/v1/analytics/content-decay', { query }) as Promise<Record<string, unknown>>;
    },
    async disconnectAccount(accountId: string, requestId?: string) {
      return request(`/v1/accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE', requestId }) as Promise<{ message?: string }>;
    },
  };
}

function zernioNotConfiguredError(message = 'A integração Zernio desta conta não está configurada.') {
  const typed = new Error(message) as Error & { retryable?: boolean; code?: string };
  typed.retryable = false;
  typed.code = 'zernio_not_configured';
  return typed;
}

export async function loadZernioConnection(organizationId: string, connectionId: string) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from('zernio_connections')
    .select('id, organization_id, label, encrypted_api_key, zernio_profile_id, status, metadata, instagram_slot_limit')
    .eq('id', connectionId)
    .eq('organization_id', organizationId)
    .is('deleted_at', null)
    .maybeSingle();

  if (error || !data?.encrypted_api_key) throw zernioNotConfiguredError('A conta Zernio selecionada não está configurada ou foi removida.');
  return data as ZernioConnectionRecord;
}

export async function createZernioClientForConnection(organizationId: string, connectionId: string) {
  const connection = await loadZernioConnection(organizationId, connectionId);
  return createZernioClient(decryptToken(connection.encrypted_api_key));
}

export async function createZernioConnectionContext(organizationId: string, connectionId: string) {
  const connection = await loadZernioConnection(organizationId, connectionId);
  return {
    connection,
    client: createZernioClient(decryptToken(connection.encrypted_api_key)),
  };
}

function billingBalanceCents(payload: ZernioBillingResponse) {
  const value = payload.balance?.creditsRemainingCents;
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
}

function billingAccruedCents(payload: ZernioBillingResponse) {
  const value = payload.balance?.accruedThisPeriodCents;
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
}

function billingCurrency(payload: ZernioBillingResponse) {
  const value = payload.balance?.currency;
  return typeof value === 'string' && value.trim().length >= 3 ? value.trim().toUpperCase().slice(0, 8) : 'USD';
}

function metadataObject(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function refreshZernioConnectionBilling(organizationId: string, connectionId: string, options: { minAgeMs?: number } = {}) {
  const supabase = createSupabaseAdminClient();
  const { connection, client } = await createZernioConnectionContext(organizationId, connectionId);
  const metadata = metadataObject(connection.metadata);
  const billingMetadata = metadataObject(metadata.billing);
  const lastSyncedAt = typeof billingMetadata.syncedAt === 'string' ? Date.parse(billingMetadata.syncedAt) : 0;

  if (options.minAgeMs && lastSyncedAt && Date.now() - lastSyncedAt < options.minAgeMs) {
    return {
      skipped: true,
      balanceCents: typeof billingMetadata.creditsRemainingCents === 'number' ? billingMetadata.creditsRemainingCents : 0,
      balanceCurrency: typeof billingMetadata.currency === 'string' ? billingMetadata.currency : 'USD',
    };
  }

  const billing = await client.getBilling();
  const syncedAt = new Date().toISOString();
  const balanceCents = billingBalanceCents(billing);
  const accruedCents = billingAccruedCents(billing);
  const balanceCurrency = billingCurrency(billing);
  const nextMetadata = {
    ...metadata,
    billing: {
      plan: billing.plan ?? null,
      cycle: billing.cycle ?? null,
      balance: billing.balance ?? null,
      creditsRemainingCents: balanceCents,
      accruedThisPeriodCents: accruedCents,
      currency: balanceCurrency,
      syncedAt,
    },
    billing_error: null,
  };

  const { error } = await supabase
    .from('zernio_connections')
    .update({
      balance_cents: balanceCents,
      balance_currency: balanceCurrency,
      metadata: nextMetadata,
      last_checked_at: syncedAt,
    })
    .eq('id', connectionId)
    .eq('organization_id', organizationId);

  if (error) throw error;
  return { skipped: false, balanceCents, balanceCurrency, billing };
}

export async function createZernioClientForOrganization(organizationId: string) {
  const supabase = createSupabaseAdminClient();
  const { data: connection, error: connectionError } = await supabase
    .from('zernio_connections')
    .select('encrypted_api_key')
    .eq('organization_id', organizationId)
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!connectionError && connection?.encrypted_api_key) {
    return createZernioClient(decryptToken(connection.encrypted_api_key));
  }

  const { data, error } = await supabase
    .from('zernio_organization_settings')
    .select('encrypted_api_key')
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (error || !data?.encrypted_api_key) {
    throw zernioNotConfiguredError();
  }

  return createZernioClient(decryptToken(data.encrypted_api_key));
}
