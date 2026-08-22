export type TwitterZernioError = Error & {
  code?: string;
  httpStatus?: number;
  requestId?: string | null;
  retryAfterSeconds?: number | null;
  details?: unknown;
  existingPostId?: string | null;
};

export type TwitterZernioAccount = {
  _id?: string;
  id?: string;
  accountId?: string;
  platform?: string;
  username?: string;
  displayName?: string;
  profileUrl?: string;
  profilePicture?: string | null;
  profilePictureUrl?: string | null;
  avatarUrl?: string | null;
  active?: boolean;
  isActive?: boolean;
  profileId?: string | { _id?: string; id?: string };
  profileData?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  [key: string]: unknown;
};

export type TwitterZernioHealth = TwitterZernioAccount & {
  canPost?: boolean;
  canFetchAnalytics?: boolean;
  tokenValid?: boolean;
  needsReconnect?: boolean;
  status?: string;
  issues?: unknown[];
};

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  query?: Record<string, string | boolean | number | undefined>;
  body?: unknown;
  idempotencyKey?: string;
};

type ClientOptions = {
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

const defaultBaseUrl = process.env.ZERNIO_API_BASE_URL ?? 'https://zernio.com/api';

function urlFor(baseUrl: string, path: string, query?: RequestOptions['query']) {
  const url = new URL(`${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }
  return url;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function isTwitterOnlyAccountInventory(accounts: Array<{ platform?: unknown }>) {
  return accounts.length > 0 && accounts.every((account) => (
    typeof account.platform === 'string' && account.platform.trim().toLowerCase() === 'twitter'
  ));
}

async function readResponse(response: Response) {
  const payload = object(await response.json().catch(() => ({})));
  if (response.ok) return payload;

  const nested = object(payload.error);
  const error = new Error(
    [payload.message, nested.message, typeof payload.error === 'string' ? payload.error : null]
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
      ?? `Zernio retornou HTTP ${response.status}.`,
  ) as TwitterZernioError;
  error.code = [payload.code, nested.code, payload.reason, nested.reason]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
    ?? String(response.status);
  error.httpStatus = response.status;
  error.requestId = response.headers.get('x-request-id') ?? response.headers.get('x-vercel-id');
  const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
  error.retryAfterSeconds = Number.isFinite(retryAfter) ? retryAfter : null;
  error.details = payload.details ?? nested.details;
  const details = object(error.details);
  error.existingPostId = [payload.existingPostId, nested.existingPostId, details.existingPostId]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0) ?? null;
  throw error;
}

export function createTwitterZernioClient(apiKey: string, options: ClientOptions = {}) {
  const normalizedKey = apiKey.trim();
  if (!normalizedKey) throw new Error('Chave Zernio vazia.');
  const fetchImpl = options.fetchImpl ?? fetch;
  const configuredTimeout = Number.parseInt(process.env.TWITTER_ZERNIO_REQUEST_TIMEOUT_MS ?? '', 10);
  const timeoutMs = Math.min(Math.max(
    options.timeoutMs ?? (Number.isFinite(configuredTimeout) ? configuredTimeout : 45_000),
    5_000,
  ), 90_000);
  const baseUrl = options.baseUrl ?? defaultBaseUrl;

  async function request(path: string, requestOptions: RequestOptions = {}) {
    const response = await fetchImpl(urlFor(baseUrl, path, requestOptions.query), {
      method: requestOptions.method ?? (requestOptions.body === undefined ? 'GET' : 'POST'),
      headers: {
        Authorization: `Bearer ${normalizedKey}`,
        ...(requestOptions.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(requestOptions.idempotencyKey ? { 'Idempotency-Key': requestOptions.idempotencyKey } : {}),
      },
      body: requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body),
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return readResponse(response);
  }

  return {
    async verifyAuth() {
      return request('/v1/auth/verify') as Promise<{
        valid?: boolean;
        userId?: string;
        authType?: string;
        scope?: string | string[];
      }>;
    },
    async listProfiles(name?: string) {
      return request('/v1/profiles', { query: { name } }) as Promise<{
        profiles?: Array<{ _id?: string; id?: string; name?: string }>;
      }>;
    },
    async createProfile(name: string, idempotencyKey: string) {
      return request('/v1/profiles', { body: { name }, idempotencyKey }) as Promise<{
        profile?: { _id?: string; id?: string; name?: string };
      }>;
    },
    async startTwitterConnect(profileId: string, redirectUrl: string) {
      return request('/v1/connect/twitter', {
        query: { profileId, redirect_url: redirectUrl },
      }) as Promise<{ authUrl?: string; state?: string }>;
    },
    async listTwitterAccounts(profileId: string) {
      return request('/v1/accounts', {
        query: { profileId, platform: 'twitter' },
      }) as Promise<{ accounts?: TwitterZernioAccount[] }>;
    },
    async listAccounts(profileId: string) {
      return request('/v1/accounts', {
        query: { profileId },
      }) as Promise<{ accounts?: TwitterZernioAccount[] }>;
    },
    async getTwitterAccountHealth(profileId: string) {
      return request('/v1/accounts/health', {
        query: { profileId, platform: 'twitter' },
      }) as Promise<{ accounts?: TwitterZernioHealth[] }>;
    },
    async setAccountCapabilities(accountId: string) {
      return request(`/v1/accounts/${encodeURIComponent(accountId)}`, {
        method: 'PUT',
        body: { xCapabilities: { analytics: false, inbox: false } },
      });
    },
    async validatePost(body: unknown) {
      return request('/v1/validate/post', { body });
    },
    async validatePostLength(body: unknown) {
      return request('/v1/validate/post-length', { body });
    },
    async createPost(body: unknown, idempotencyKey: string) {
      return request('/v1/posts', { body, idempotencyKey }) as Promise<{ post?: Record<string, unknown>; existingPost?: Record<string, unknown> }>;
    },
    async getPost(postId: string) {
      return request(`/v1/posts/${encodeURIComponent(postId)}`) as Promise<{ post?: Record<string, unknown> }>;
    },
    async getUsageSnapshot() {
      return request('/v1/usage') as Promise<{
        billingSystem?: string;
        usage?: { xApiCallsByOperation?: Record<string, number> };
        spend?: {
          currentPeriodCents?: number;
          xSpendCents?: number;
          xSpendLimitCents?: number;
        };
      }>;
    },
  };
}

export function stableZernioAccountId(account: TwitterZernioAccount) {
  return [account._id, account.id, account.accountId]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
    ?.trim() ?? null;
}

export function immutableTwitterUserId(account: TwitterZernioAccount) {
  const profileData = object(account.profileData);
  const metadata = object(account.metadata);
  return [
    account.twitterUserId,
    account.platformUserId,
    account.userId,
    profileData.twitterUserId,
    profileData.platformUserId,
    profileData.userId,
    profileData.id,
    metadata.twitterUserId,
    metadata.platformUserId,
    metadata.userId,
  ].find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim() ?? null;
}

export function zernioProfileId(account: TwitterZernioAccount) {
  if (typeof account.profileId === 'string') return account.profileId;
  return account.profileId?._id ?? account.profileId?.id ?? null;
}
