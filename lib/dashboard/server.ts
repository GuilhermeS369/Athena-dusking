import { createSupabaseServerClient } from '@/lib/supabase/server';

export type DashboardData = {
  connections: { total: number; healthy: number; attention: number };
  operationalProfiles: number;
  scheduled: { total: number; nextAt: string | null };
  review: { total: number; failedPublications: number; profilesNeedingReauth: number };
  summary: {
    totalPosts: number;
    publishedPosts: number;
    nextScheduleAt: string | null;
    followersTotal: number;
    followersDelta: number;
    viewsTotal: number;
    reachTotal: number;
    interactionsTotal: number;
    analyticsAvailableProfiles: number;
    analyticsUnavailableProfiles: number;
  };
  onboarding: { profileConnected: boolean; groupCreated: boolean; mediaUploaded: boolean };
  analytics: {
    profiles: Array<{ id: string; username: string; display_name: string | null; provider: 'meta_official' | 'zernio'; status: string }>;
    groups: Array<{ id: string; name: string; profile_ids: string[] }>;
    snapshots: Array<{
      profile_id: string;
      period_start: string;
      period_end: string;
      followers_count: number;
      followers_delta: number;
      impressions: number;
      reach: number;
      views: number;
      likes: number;
      comments: number;
      shares: number;
      saves: number;
      total_interactions: number;
      posts_count: number;
      engagement_rate: number;
      sync_status: string;
      synced_at: string | null;
    }>;
    dailyMetrics: Array<{
      profile_id: string;
      date: string;
      posts: number;
      impressions: number;
      reach: number;
      views: number;
      likes: number;
      comments: number;
      shares: number;
      saves: number;
      interactions: number;
    }>;
    followerHistory: Array<{ profile_id: string; snapshot_date: string; followers_count: number; followers_gained: number; followers_lost: number }>;
    posts: Array<{
      id: string;
      profile_id: string;
      platform_post_url: string | null;
      content: string | null;
      media_type: string | null;
      thumbnail_url: string | null;
      published_at: string | null;
      views: number;
      reach: number;
      likes: number;
      comments: number;
      shares: number;
      saves: number;
      total_interactions: number;
      engagement_rate: number;
      sync_status: string;
    }>;
    publishedItems: Array<{ id: string; profile_id: string; published_at: string }>;
    publicationRollups: Array<{ kind: string; profile_id: string; label: string; total: number }>;
  };
};

export async function getDashboardData(organizationId: string): Promise<DashboardData> {
  const supabase = await createSupabaseServerClient();
  const analyticsSince = new Date();
  analyticsSince.setDate(analyticsSince.getDate() - 370);
  const analyticsSinceDate = analyticsSince.toISOString().slice(0, 10);
  const analyticsSinceIso = analyticsSince.toISOString();

  const [summaryResult, profilesResult, groupsResult, groupMembersResult, snapshotsResult, dailyMetricsResult, followerResult, postsResult, publishedItemsResult, publicationRollupsResult] = await Promise.all([
    supabase.rpc('get_dashboard_analytics_summary', { p_organization_id: organizationId }).maybeSingle(),
    supabase
      .from('instagram_profiles_safe')
      .select('id, username, display_name, provider, status')
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .order('username', { ascending: true }),
    supabase
      .from('profile_groups')
      .select('id, name')
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .order('name', { ascending: true }),
    supabase
      .from('profile_group_members')
      .select('group_id, profile_id')
      .eq('organization_id', organizationId),
    supabase
      .from('profile_analytics_snapshots')
      .select('profile_id, period_start, period_end, followers_count, followers_delta, impressions, reach, views, likes, comments, shares, saves, total_interactions, posts_count, engagement_rate, sync_status, synced_at')
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .gte('period_end', analyticsSinceDate)
      .order('period_end', { ascending: false })
      .limit(1000),
    supabase
      .from('profile_analytics_daily_metrics')
      .select('profile_id, metric_date, posts, impressions, reach, views, likes, comments, shares, saves, interactions')
      .eq('organization_id', organizationId)
      .gte('metric_date', analyticsSinceDate)
      .in('coverage_status', ['complete', 'partial'])
      .order('metric_date', { ascending: true })
      .limit(10000),
    supabase
      .from('profile_follower_daily_snapshots')
      .select('profile_id, snapshot_date, followers_count, followers_gained, followers_lost')
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .gte('snapshot_date', analyticsSinceDate)
      .order('snapshot_date', { ascending: true })
      .limit(5000),
    supabase
      .from('profile_post_analytics_snapshots')
      .select('id, profile_id, platform_post_url, content, media_type, thumbnail_url, published_at, views, reach, likes, comments, shares, saves, total_interactions, engagement_rate, sync_status')
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .gte('published_at', analyticsSinceIso)
      .order('total_interactions', { ascending: false })
      .limit(5000),
    supabase
      .from('publication_items')
      .select('id, profile_id, published_at')
      .eq('organization_id', organizationId)
      .eq('status', 'published')
      .not('published_at', 'is', null)
      .gte('published_at', analyticsSinceIso)
      .order('published_at', { ascending: true })
      .limit(10000),
    supabase.rpc('get_dashboard_publication_rollups', { p_organization_id: organizationId, p_days: 365 }),
  ]);

  const sectionErrors = {
    summary: summaryResult.error ?? (!summaryResult.data ? { message: 'Resumo sem dados.' } : null),
    profiles: profilesResult.error,
    groups: groupsResult.error,
    groupMembers: groupMembersResult.error,
    snapshots: snapshotsResult.error,
    dailyMetrics: dailyMetricsResult.error,
    followerHistory: followerResult.error,
    posts: postsResult.error,
    publishedItems: publishedItemsResult.error,
    publicationRollups: publicationRollupsResult.error,
  };
  const unavailableSections = Object.entries(sectionErrors)
    .filter(([, error]) => Boolean(error))
    .map(([section]) => section);

  if (unavailableSections.length > 0) {
    // Analytics e operação são seções independentes. Uma fonte degradada não
    // pode impedir filtros, agenda e os demais painéis de renderizarem.
    console.error('Dashboard carregada parcialmente.', {
      organizationId,
      unavailableSections,
      errors: sectionErrors,
    });
  }

  type DashboardSummaryRow = {
    connections_total: number;
    connections_healthy: number;
    connections_attention: number;
    operational_profiles: number;
    scheduled_total: number;
    next_scheduled_at: string | null;
    failed_publications: number;
    profiles_needing_reauth: number;
    total_posts: number;
    published_total: number;
    followers_total: number;
    followers_delta: number;
    views_total: number;
    reach_total: number;
    interactions_total: number;
    analytics_available_profiles: number;
    analytics_unavailable_profiles: number;
    ready_assets: number;
    groups_total: number;
  };
  const emptySummary: DashboardSummaryRow = {
    connections_total: 0,
    connections_healthy: 0,
    connections_attention: 0,
    operational_profiles: 0,
    scheduled_total: 0,
    next_scheduled_at: null,
    failed_publications: 0,
    profiles_needing_reauth: 0,
    total_posts: 0,
    published_total: 0,
    followers_total: 0,
    followers_delta: 0,
    views_total: 0,
    reach_total: 0,
    interactions_total: 0,
    analytics_available_profiles: 0,
    analytics_unavailable_profiles: 0,
    ready_assets: 0,
    groups_total: 0,
  };
  const row = (summaryResult.data ?? emptySummary) as DashboardSummaryRow;
  const profiles = (profilesResult.data ?? []) as DashboardData['analytics']['profiles'];
  const membersByGroup = new Map<string, string[]>();
  for (const member of (groupMembersResult.data ?? []) as Array<{ group_id: string; profile_id: string }>) {
    membersByGroup.set(member.group_id, [...(membersByGroup.get(member.group_id) ?? []), member.profile_id]);
  }
  const groups = ((groupsResult.data ?? []) as Array<{ id: string; name: string }>).map((group) => ({
    ...group,
    profile_ids: membersByGroup.get(group.id) ?? [],
  }));
  const snapshots = (snapshotsResult.data ?? []) as DashboardData['analytics']['snapshots'];
  const usableSnapshots = latestUsableSnapshotsByProfile(snapshots);
  const dailyMetrics = (dailyMetricsResult.data ?? []).map((row) => ({ ...row, date: row.metric_date })) as DashboardData['analytics']['dailyMetrics'];

  return {
    connections: { total: row.connections_total, healthy: row.connections_healthy, attention: row.connections_attention },
    operationalProfiles: row.operational_profiles,
    scheduled: { total: row.scheduled_total, nextAt: row.next_scheduled_at },
    review: { total: row.failed_publications + row.profiles_needing_reauth, failedPublications: row.failed_publications, profilesNeedingReauth: row.profiles_needing_reauth },
    summary: {
      totalPosts: row.total_posts,
      publishedPosts: row.published_total,
      nextScheduleAt: row.next_scheduled_at,
      followersTotal: row.followers_total,
      followersDelta: row.followers_delta,
      viewsTotal: row.views_total,
      reachTotal: row.reach_total,
      interactionsTotal: row.interactions_total,
      analyticsAvailableProfiles: row.analytics_available_profiles,
      analyticsUnavailableProfiles: row.analytics_unavailable_profiles,
    },
    onboarding: {
      profileConnected: row.connections_total > 0,
      groupCreated: row.groups_total > 0,
      mediaUploaded: row.ready_assets > 0,
    },
    analytics: {
      profiles,
      groups,
      snapshots: usableSnapshots,
      dailyMetrics,
      followerHistory: (followerResult.data ?? []) as DashboardData['analytics']['followerHistory'],
      posts: (postsResult.data ?? []) as DashboardData['analytics']['posts'],
      publishedItems: (publishedItemsResult.data ?? []) as DashboardData['analytics']['publishedItems'],
      publicationRollups: (publicationRollupsResult.data ?? []) as DashboardData['analytics']['publicationRollups'],
    },
  };
}

function latestUsableSnapshotsByProfile(snapshots: DashboardData['analytics']['snapshots']) {
  const latest = new Map<string, (typeof snapshots)[number]>();
  for (const snapshot of snapshots) {
    if (snapshot.sync_status === 'failed') continue;
    const current = latest.get(snapshot.profile_id);
    if (!current || (snapshot.synced_at ?? '') > (current.synced_at ?? '') || ((snapshot.synced_at ?? '') === (current.synced_at ?? '') && snapshot.period_end > current.period_end)) {
      latest.set(snapshot.profile_id, snapshot);
    }
  }
  return Array.from(latest.values());
}
