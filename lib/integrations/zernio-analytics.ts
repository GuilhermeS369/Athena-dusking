import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import {
  createZernioClientForConnection,
  createZernioClientForOrganization,
  type ZernioAnalyticsListResponse,
  type ZernioAnalyticsMetrics,
  type ZernioAnalyticsPost,
  type ZernioError,
  type ZernioFollowerHistoryResponse,
  type ZernioInstagramAccountInsightsResponse,
} from '@/lib/integrations/zernio-client';
import { latestFollowerRow, normalizeFollowerRows, numberValue } from '@/lib/integrations/zernio-analytics-normalizers';
import { currentFollowersFromAccount, currentFollowersFromFollowerStats } from '@/lib/integrations/zernio-analytics-normalizers';

export type AnalyticsStatus = 'pending' | 'synced' | 'partial' | 'no_data' | 'not_configured' | 'unavailable_plan' | 'permission_missing' | 'rate_limited' | 'failed';

type AnalyticsStepTelemetry = {
  step: 'profile_lookup' | 'sync_run_create' | 'zernio_account_insights' | 'zernio_accounts' | 'zernio_follower_history' | 'zernio_post_analytics' | 'zernio_current_posts' | 'zernio_daily_metrics' | 'snapshot_persist' | 'daily_metrics_persist' | 'follower_history_persist' | 'post_analytics_persist';
  outcome: 'success' | 'partial' | 'error' | 'skipped';
  durationMs: number;
  errorClass?: string;
  errorCode?: string;
};

type SyncProfileAnalyticsOptions = {
  organizationId: string;
  force?: boolean;
  onStep?: (event: AnalyticsStepTelemetry) => void;
};

type ProfileRecord = {
  id: string;
  organization_id: string;
  provider: 'meta_official' | 'zernio';
  zernio_account_id: string | null;
  zernio_connection_id: string | null;
  zernio_profile_id: string | null;
  zernio_account_metadata: Record<string, unknown> | null;
  deleted_at: string | null;
};

const ANALYTICS_COOLDOWN_MS = 30 * 60 * 1000;
// A Zernio rejeita janelas superiores a 89 dias. O refresh operacional só
// revisita os últimos quatro dias: hoje é parcial e os dias anteriores podem
// sofrer atraso de consolidação no provedor.
const DEFAULT_RANGE_DAYS = 4;
const insightMetrics = [
  'reach',
  'views',
  'accounts_engaged',
  'total_interactions',
  'comments',
  'likes',
  'saves',
  'shares',
  'replies',
  'follows_and_unfollows',
  'profile_links_taps',
].join(',');

function saoPauloDate(daysAgo = 0) {
  const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function metricTotal(payload: ZernioInstagramAccountInsightsResponse, key: string) {
  return numberValue(payload.metrics?.[key]?.total);
}

function hasInsightMetrics(payload: ZernioInstagramAccountInsightsResponse) {
  return Object.keys(payload.metrics ?? {}).length > 0;
}

function normalizeError(error: unknown): { status: AnalyticsStatus; code: string; message: string; retryable: boolean } {
  const typed = error as ZernioError | undefined;
  const code = String(typed?.code ?? '').toLowerCase();
  const message = typed?.message || 'Não foi possível sincronizar analytics.';
  const searchable = `${code} ${message} ${JSON.stringify(typed?.details ?? {})}`.toLowerCase();

  if (code === '402' || searchable.includes('analytics_addon_required') || searchable.includes('analytics add-on') || searchable.includes('analytics access')) {
    return { status: 'no_data', code: typed?.code ?? 'zernio_analytics_no_data', message: 'A Zernio não retornou métricas para este perfil nesta janela. A próxima sincronização tentará coletar novamente.', retryable: false };
  }
  if (code === '401' || code === '403' || searchable.includes('permission') || searchable.includes('forbidden')) {
    return { status: 'permission_missing', code: typed?.code ?? 'permission_missing', message, retryable: false };
  }
  if (code === '429' || searchable.includes('rate limit')) {
    return { status: 'rate_limited', code: typed?.code ?? 'rate_limited', message, retryable: true };
  }
  const retryable = typed?.retryable === true
    || /^5\d\d$/.test(code)
    || searchable.includes('timeout')
    || searchable.includes('timed out')
    || searchable.includes('fetch failed')
    || searchable.includes('econnreset');
  return { status: 'failed', code: typed?.code ?? 'zernio_analytics_failed', message, retryable };
}

function followersRows(payload: ZernioFollowerHistoryResponse) {
  return normalizeFollowerRows(payload);
}

function analyticsPosts(payload: ZernioAnalyticsListResponse | ZernioAnalyticsPost) {
  if ('posts' in payload && Array.isArray(payload.posts)) return payload.posts;
  if ('postId' in payload || 'platformAnalytics' in payload) return [payload as ZernioAnalyticsPost];
  return [];
}

function postId(post: ZernioAnalyticsPost) {
  return post.postId ?? post.latePostId ?? post._id ?? post.id ?? '';
}

function platformMetrics(post: ZernioAnalyticsPost): ZernioAnalyticsMetrics {
  return post.platformAnalytics?.find((entry) => entry.platform === 'instagram')?.analytics ?? post.analytics ?? {};
}

function platformPostId(post: ZernioAnalyticsPost) {
  return post.platformPostId
    ?? post.platformAnalytics?.find((entry) => entry.platform === 'instagram')?.platformPostId
    ?? null;
}

function platformPostUrl(post: ZernioAnalyticsPost) {
  return post.platformPostUrl
    ?? post.platformAnalytics?.find((entry) => entry.platform === 'instagram')?.platformPostUrl
    ?? null;
}

function normalizedDailyMetrics(payload: unknown, profile: ProfileRecord, coverageStatus: 'complete' | 'partial') {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const dailyData = (payload as { dailyData?: unknown }).dailyData;
  if (!Array.isArray(dailyData)) return [];
  const rows = new Map<string, Record<string, unknown>>();
  for (const raw of dailyData) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const date = typeof row.date === 'string' ? row.date.slice(0, 10) : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const metrics = row.metrics && typeof row.metrics === 'object' && !Array.isArray(row.metrics) ? row.metrics as Record<string, unknown> : {};
    const likes = numberValue(metrics.likes);
    const comments = numberValue(metrics.comments);
    const shares = numberValue(metrics.shares);
    const saves = numberValue(metrics.saves);
    rows.set(date, {
      organization_id: profile.organization_id,
      profile_id: profile.id,
      provider: profile.provider,
      metric_date: date,
      posts: numberValue(row.postCount),
      impressions: numberValue(metrics.impressions),
      reach: numberValue(metrics.reach),
      views: numberValue(metrics.views),
      likes,
      comments,
      shares,
      saves,
      interactions: likes + comments + shares + saves,
      coverage_status: coverageStatus,
      source_payload: raw,
      normalized_at: new Date().toISOString(),
    });
  }
  return Array.from(rows.values());
}

async function createRun(admin: ReturnType<typeof createSupabaseAdminClient>, profile: ProfileRecord, syncKind: string, periodStart: string, periodEnd: string) {
  const { data } = await admin
    .from('profile_analytics_sync_runs')
    .insert({
      organization_id: profile.organization_id,
      profile_id: profile.id,
      provider: profile.provider,
      sync_kind: syncKind,
      period_start: periodStart,
      period_end: periodEnd,
      status: 'pending',
    })
    .select('id')
    .maybeSingle();
  return data?.id as string | undefined;
}

async function finishRun(admin: ReturnType<typeof createSupabaseAdminClient>, runId: string | undefined, status: AnalyticsStatus, metadata: Record<string, unknown>, error?: { code?: string; message?: string }, skipped = false) {
  if (!runId) return;
  await admin
    .from('profile_analytics_sync_runs')
    .update({
      status,
      skipped,
      error_code: error?.code ?? null,
      error_message: error?.message ?? null,
      metadata,
      finished_at: new Date().toISOString(),
    })
    .eq('id', runId);
}

export async function initializeProfileAnalyticsState(profileId: string) {
  const admin = createSupabaseAdminClient();
  await admin.rpc('initialize_profile_analytics_state', { p_profile_id: profileId });
}

export async function softDeleteProfileAnalytics(profileId: string) {
  const admin = createSupabaseAdminClient();
  await admin.rpc('soft_delete_profile_analytics', { p_profile_id: profileId });
}

export async function syncProfileAnalytics(profileId: string, options: SyncProfileAnalyticsOptions) {
  const admin = createSupabaseAdminClient();
  const recordStep = (event: AnalyticsStepTelemetry) => options.onStep?.(event);
  const timed = async <T>(step: AnalyticsStepTelemetry['step'], operation: () => Promise<T>): Promise<T> => {
    const startedAt = performance.now();
    try {
      const value = await operation();
      recordStep({ step, outcome: 'success', durationMs: performance.now() - startedAt });
      return value;
    } catch (error) {
      const normalized = normalizeError(error);
      recordStep({ step, outcome: 'error', durationMs: performance.now() - startedAt, errorClass: normalized.status, errorCode: normalized.code });
      throw error;
    }
  };
  const periodEnd = saoPauloDate(0);
  const periodStart = saoPauloDate(DEFAULT_RANGE_DAYS - 1);

  const profileStartedAt = performance.now();
  const { data: profile, error: profileError } = await admin
    .from('instagram_profiles')
    .select('id, organization_id, provider, zernio_account_id, zernio_connection_id, zernio_profile_id, zernio_account_metadata, deleted_at')
    .eq('id', profileId)
    .eq('organization_id', options.organizationId)
    .is('deleted_at', null)
    .maybeSingle();

  if (profileError || !profile) {
    recordStep({ step: 'profile_lookup', outcome: 'error', durationMs: performance.now() - profileStartedAt, errorCode: profileError?.code ?? 'profile_not_found' });
    throw new Error('Perfil não encontrado para sincronizar analytics.');
  }
  recordStep({ step: 'profile_lookup', outcome: 'success', durationMs: performance.now() - profileStartedAt });
  const typedProfile = profile as ProfileRecord;

  const existingRun = await admin
    .from('profile_analytics_sync_runs')
    .select('id, started_at, status')
    .eq('organization_id', typedProfile.organization_id)
    .eq('profile_id', typedProfile.id)
    .eq('sync_kind', 'profile_analytics')
    .is('deleted_at', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!options.force && existingRun.data?.started_at && Date.now() - Date.parse(existingRun.data.started_at) < ANALYTICS_COOLDOWN_MS) {
    return { status: existingRun.data.status as AnalyticsStatus, skipped: true, message: 'Analytics já sincronizado recentemente.' };
  }

  const runId = await timed('sync_run_create', () => createRun(admin, typedProfile, 'profile_analytics', periodStart, periodEnd));

  if (typedProfile.provider !== 'zernio') {
    await admin.from('profile_analytics_snapshots').upsert({
      organization_id: typedProfile.organization_id,
      profile_id: typedProfile.id,
      provider: typedProfile.provider,
      period_start: periodStart,
      period_end: periodEnd,
      sync_status: 'not_configured',
      unavailable_reason: 'Meta oficial ainda não tem coleta de analytics configurada no Athena.',
      synced_at: new Date().toISOString(),
    }, { onConflict: 'organization_id,profile_id,provider,period_start,period_end' });

    await finishRun(admin, runId, 'not_configured', { provider: typedProfile.provider });
    return { status: 'not_configured' as AnalyticsStatus, skipped: false, message: 'Analytics da Meta oficial ainda não configurado.' };
  }

  if (!typedProfile.zernio_account_id) {
    await finishRun(admin, runId, 'not_configured', {}, { code: 'missing_zernio_account_id', message: 'Perfil sem social account da Zernio.' });
    return { status: 'not_configured' as AnalyticsStatus, skipped: false, message: 'Perfil sem social account da Zernio.' };
  }
  const zernioAccountId = typedProfile.zernio_account_id;

  try {
    const client = typedProfile.zernio_connection_id
      ? await createZernioClientForConnection(typedProfile.organization_id, typedProfile.zernio_connection_id)
      : await createZernioClientForOrganization(typedProfile.organization_id);
    const insights = await timed('zernio_account_insights', () => client.getInstagramAccountInsights({
      accountId: zernioAccountId,
      metrics: insightMetrics,
      since: periodStart,
      until: periodEnd,
      metricType: 'total_value',
    }));

    const partialSources: string[] = [];
    let followerRows: ReturnType<typeof followersRows> = [];
    let followerHistoryPayload: ZernioFollowerHistoryResponse | null = null;
    let liveAccountPayload: Record<string, unknown> | null = null;
    try {
      const accountsPayload = await timed('zernio_accounts', () => client.listAccounts());
      liveAccountPayload = (accountsPayload.accounts ?? []).find((account) => (account.accountId ?? account._id ?? account.id) === zernioAccountId) ?? null;
    } catch {
      liveAccountPayload = null;
      partialSources.push('accounts');
    }

    try {
      followerHistoryPayload = await timed('zernio_follower_history', () => client.getInstagramFollowerHistory({
        accountId: zernioAccountId,
        metrics: 'follower_count,followers_gained,followers_lost',
        since: periodStart,
        until: periodEnd,
        metricType: 'time_series',
      }));
      followerRows = followersRows(followerHistoryPayload);
    } catch {
      followerRows = [];
      partialSources.push('follower_history');
    }

    let postRows: ZernioAnalyticsPost[] = [];
    let postAnalyticsPayload: ZernioAnalyticsListResponse | ZernioAnalyticsPost | null = null;
    try {
      postAnalyticsPayload = await timed('zernio_post_analytics', () => client.getAnalytics({ platform: 'instagram', accountId: zernioAccountId, source: 'all', fromDate: periodStart, toDate: periodEnd, limit: 25, page: 1, sortBy: 'date', order: 'desc' }));
      postRows = analyticsPosts(postAnalyticsPayload);
    } catch {
      postRows = [];
      partialSources.push('post_analytics');
    }

    let currentPostsPayload: { posts?: ZernioAnalyticsPost[]; pagination?: { page?: number; limit?: number; total?: number; pages?: number } } | null = null;
    try {
      const postsPayload = await timed('zernio_current_posts', () => client.listPosts({ platform: 'instagram', accountId: zernioAccountId, source: 'external', status: 'published', limit: 50, page: 1, sortBy: 'date' }));
      currentPostsPayload = postsPayload as { posts?: ZernioAnalyticsPost[]; pagination?: { page?: number; limit?: number; total?: number; pages?: number } };
      const knownIds = new Set(postRows.map((post) => postId(post)).filter(Boolean));
      for (const post of (postsPayload.posts ?? []) as ZernioAnalyticsPost[]) {
        const id = postId(post);
        if (id && !knownIds.has(id)) postRows.push(post);
      }
    } catch {
      currentPostsPayload = null;
      partialSources.push('current_posts');
    }

    const optionalSource = async <T>(name: string, operation: Promise<T>) => operation.catch(() => {
      partialSources.push(name);
      return null;
    });
    const [dailyMetrics] = await Promise.all([
      optionalSource('daily_metrics', timed('zernio_daily_metrics', () => client.getDailyMetrics({ platform: 'instagram', accountId: zernioAccountId, fromDate: periodStart, toDate: periodEnd, source: 'all' }))),
    ]);

    const newestFollower = latestFollowerRow(followerRows);
    const oldestFollower = followerRows[0];
    const liveFollowersCount = currentFollowersFromAccount(liveAccountPayload) ?? currentFollowersFromAccount(typedProfile.zernio_account_metadata) ?? newestFollower?.followers_count ?? 0;
    const followersCount = liveFollowersCount;
    const followersDelta = newestFollower && oldestFollower ? newestFollower.followers_count - oldestFollower.followers_count : 0;
    const totalInteractions = metricTotal(insights, 'total_interactions') || metricTotal(insights, 'accounts_engaged');
    const reach = metricTotal(insights, 'reach');
    const engagementRate = reach > 0 ? Number(((totalInteractions / reach) * 100).toFixed(4)) : 0;
    const unavailable = insights.unavailableMetrics?.map((metric) => `${metric.metric}: ${metric.reason}`).join(' · ') ?? null;
    const hasUsableData = hasInsightMetrics(insights) || followerRows.length > 0 || postRows.length > 0 || liveAccountPayload !== null;
    const syncStatus: AnalyticsStatus = hasUsableData
      ? partialSources.length > 0 ? 'partial' : 'synced'
      : 'no_data';

    await timed('snapshot_persist', async () => {
      const { error } = await admin.from('profile_analytics_snapshots').upsert({
      organization_id: typedProfile.organization_id,
      profile_id: typedProfile.id,
      provider: typedProfile.provider,
      period_start: periodStart,
      period_end: periodEnd,
      followers_count: followersCount,
      followers_delta: followersDelta,
      followers_gained: followerRows.reduce((sum, row) => sum + row.followers_gained, 0),
      followers_lost: followerRows.reduce((sum, row) => sum + row.followers_lost, 0),
      impressions: metricTotal(insights, 'impressions'),
      reach,
      views: metricTotal(insights, 'views'),
      likes: metricTotal(insights, 'likes'),
      comments: metricTotal(insights, 'comments'),
      shares: metricTotal(insights, 'shares'),
      saves: metricTotal(insights, 'saves'),
      replies: metricTotal(insights, 'replies'),
      total_interactions: totalInteractions,
      profile_links_taps: metricTotal(insights, 'profile_links_taps'),
      posts_count: postRows.length,
      engagement_rate: engagementRate,
      sync_status: syncStatus,
      unavailable_reason: unavailable
        ?? (syncStatus === 'partial'
          ? `Coleta parcial; fontes temporariamente indisponíveis: ${partialSources.join(', ')}.`
          : syncStatus === 'no_data'
            ? 'A Zernio respondeu sem métricas para esta janela. Sincronize novamente depois que houver dados no período.'
            : null),
      last_error_code: null,
      last_error_message: null,
      raw_payload: {
        documentation_audit: {
          instagram: 'https://docs.zernio.com/platforms/instagram',
          account_insights: 'GET /v1/analytics/instagram/account-insights',
          follower_history: 'GET /v1/analytics/instagram/follower-history',
          live_account: 'GET /v1/accounts',
          current_posts: 'GET /v1/posts?source=external&status=published',
          post_analytics: 'GET /v1/analytics',
          daily_metrics: 'GET /v1/analytics/daily-metrics',
        },
        accountInsights: insights,
        liveAccount: liveAccountPayload,
        liveFollowers: { followersCount: liveFollowersCount, source: currentFollowersFromAccount(liveAccountPayload) ? 'accounts.followersCount' : currentFollowersFromAccount(typedProfile.zernio_account_metadata) ? 'instagram_profiles.zernio_account_metadata' : newestFollower ? 'follower-history.latest' : 'unavailable' },
        followerHistory: followerHistoryPayload,
        postAnalytics: postAnalyticsPayload,
        currentPosts: currentPostsPayload,
        dailyMetrics,
      },
      synced_at: new Date().toISOString(),
      deleted_at: null,
      }, { onConflict: 'organization_id,profile_id,provider,period_start,period_end' });
      if (error) throw error;
    });

    const dailyCacheRows = normalizedDailyMetrics(dailyMetrics, typedProfile, syncStatus === 'partial' ? 'partial' : 'complete');
    if (dailyCacheRows.length > 0) {
      await timed('daily_metrics_persist', async () => {
        const { error } = await admin.from('profile_analytics_daily_metrics')
        .upsert(dailyCacheRows, { onConflict: 'organization_id,profile_id,provider,metric_date' });
        if (error) throw error;
      });
    }

    if (followerRows.length > 0) {
      await timed('follower_history_persist', async () => {
        const { error } = await admin.from('profile_follower_daily_snapshots').upsert(followerRows.map((row) => ({
        organization_id: typedProfile.organization_id,
        profile_id: typedProfile.id,
        provider: typedProfile.provider,
        ...row,
        sync_status: 'synced',
        synced_at: new Date().toISOString(),
        deleted_at: null,
        })), { onConflict: 'organization_id,profile_id,provider,snapshot_date' });
        if (error) throw error;
      });
    }

    const postUpserts = postRows.flatMap((post) => {
      const id = postId(post);
      if (!id) return [];
      const metrics = platformMetrics(post);
      const interactions = numberValue(metrics.likes) + numberValue(metrics.comments) + numberValue(metrics.shares) + numberValue(metrics.saves);
      return [{
        organization_id: typedProfile.organization_id,
        profile_id: typedProfile.id,
        provider: typedProfile.provider,
        zernio_post_id: id,
        platform_post_id: platformPostId(post),
        platform_post_url: platformPostUrl(post),
        source: post.isExternal ? 'external' : 'zernio',
        status: post.status ?? null,
        content: post.content ?? null,
        media_type: post.mediaType ?? null,
        thumbnail_url: post.thumbnailUrl ?? null,
        published_at: post.publishedAt ?? post.scheduledFor ?? null,
        impressions: numberValue(metrics.impressions),
        reach: numberValue(metrics.reach),
        views: numberValue(metrics.views),
        likes: numberValue(metrics.likes),
        comments: numberValue(metrics.comments),
        shares: numberValue(metrics.shares),
        saves: numberValue(metrics.saves),
        clicks: numberValue(metrics.clicks),
        follows: numberValue(metrics.follows),
        total_interactions: interactions,
        engagement_rate: numberValue(metrics.engagementRate),
        sync_status: 'synced',
        last_error_message: null,
        raw_payload: post,
        synced_at: new Date().toISOString(),
        deleted_at: null,
      }];
    });

    if (postUpserts.length > 0) {
      await timed('post_analytics_persist', async () => {
        const { error } = await admin.from('profile_post_analytics_snapshots').upsert(postUpserts, { onConflict: 'organization_id,zernio_post_id' });
        if (error) throw error;
      });
    }

    await finishRun(admin, runId, syncStatus, { followerRows: followerRows.length, postRows: postRows.length, unavailableMetrics: insights.unavailableMetrics ?? [], hasInsightMetrics: hasInsightMetrics(insights), partialSources });
    return {
      status: syncStatus,
      skipped: false,
      message: syncStatus === 'synced'
        ? 'Analytics sincronizado com sucesso.'
        : syncStatus === 'partial'
          ? `Analytics sincronizado parcialmente; fontes pendentes: ${partialSources.join(', ')}.`
          : 'A Zernio respondeu sem métricas para esta janela.',
    };
  } catch (error) {
    const normalized = normalizeError(error);
    await admin.from('profile_analytics_snapshots').upsert({
      organization_id: typedProfile.organization_id,
      profile_id: typedProfile.id,
      provider: typedProfile.provider,
      period_start: periodStart,
      period_end: periodEnd,
      sync_status: normalized.status,
      unavailable_reason: normalized.status === 'unavailable_plan' || normalized.status === 'no_data' ? normalized.message : null,
      last_error_code: normalized.code,
      last_error_message: normalized.message,
      synced_at: new Date().toISOString(),
      raw_payload: { error: normalized },
      deleted_at: null,
    }, { onConflict: 'organization_id,profile_id,provider,period_start,period_end' });
    await finishRun(admin, runId, normalized.status, {}, { code: normalized.code, message: normalized.message });
    return { status: normalized.status, skipped: false, code: normalized.code, retryable: normalized.retryable, message: normalized.message };
  }
}
