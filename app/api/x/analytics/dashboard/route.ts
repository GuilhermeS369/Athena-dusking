import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { getTwitterRequestContext } from '@/lib/twitter/request-context';

export const dynamic = 'force-dynamic';

const METRICS = new Set(['impressions', 'views', 'likes', 'comments', 'shares', 'engagement']);
const PAGE_SIZE = 1000;

type Json = Record<string, unknown>;
type Profile = { id: string; current_connection_id: string | null; username: string; display_name: string | null; avatar_url: string | null; can_fetch_analytics: boolean; analytics_enabled: boolean; status: string };
type Connection = { id: string; label: string; analytics_enabled: boolean; status: string };
type Group = { id: string; name: string };
type Snapshot = { id: string; resource_type: 'profile' | 'post'; profile_id: string; publication_item_id: string | null; metrics: Json; provider_updated_at: string | null; captured_at: string };
type PostItem = { id: string; profile_id: string; connection_id: string; content: string; execute_at: string };
type FollowerPoint = { profileId: string; connectionId: string | null; date: string; followers: number };
type PostMetric = { publicationItemId: string; profileId: string; connectionId: string | null; collectionStage: string | null; capturedAt: string; publishedAt: string | null; content: string; url: string | null; impressions: number; views: number; likes: number; comments: number; shares: number; engagement: number };

function isoDate(value: string | null) {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

function number(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function object(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
}

function array(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function dateKey(value: unknown, fallback: string) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : fallback.slice(0, 10);
}

function postPayload(metrics: Json) {
  const platform = array(metrics.platformAnalytics).map(object).find((item) => item.platform === 'twitter') ?? {};
  return object(Object.keys(object(platform.analytics)).length ? platform.analytics : metrics.analytics);
}

function metricValue(item: PostMetric, metric: string) {
  return item[metric as keyof Pick<PostMetric, 'impressions' | 'views' | 'likes' | 'comments' | 'shares' | 'engagement'>];
}

async function allRows(makeQuery: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message?: string } | null }>) {
  const rows: unknown[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const result = await makeQuery(from, from + PAGE_SIZE - 1);
    if (result.error) return { data: [] as unknown[], error: result.error };
    const page = result.data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return { data: rows, error: null };
  }
}

export async function GET(request: Request) {
  const auth = await getTwitterRequestContext();
  if ('response' in auth) return auth.response;

  const params = new URL(request.url).searchParams;
  const metric = params.get('metric') ?? 'engagement';
  const connectionId = params.get('connectionId');
  const profileId = params.get('profileId');
  const groupId = params.get('groupId');
  const start = params.get('start');
  const end = params.get('end');
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);
  const limit = Math.min(50, Math.max(1, Number.parseInt(params.get('limit') ?? '12', 10) || 12));
  if (!METRICS.has(metric) || !isoDate(start) || !isoDate(end) || start! > end!) {
    return NextResponse.json({ error: 'Filtros inválidos.' }, { status: 400 });
  }

  const organizationId = auth.context.activeOrganization.id;
  const admin = createSupabaseAdminClient();
  const [profilesResult, connectionsResult, groupsResult, membersResult] = await Promise.all([
    // As consultas pesadas mais abaixo já usam allRows(), mas recebiam
    // scopedProfileList derivado desta lista truncada — paginavam corretamente um
    // universo errado. O escopo precisa nascer completo.
    allRows((from, to) => admin.from('twitter_profiles').select('id,current_connection_id,username,display_name,avatar_url,can_fetch_analytics,analytics_enabled,status').eq('organization_id', organizationId).is('deleted_at', null).order('username').order('id').range(from, to)),
    allRows((from, to) => admin.from('twitter_connections').select('id,label,analytics_enabled,status').eq('organization_id', organizationId).is('deleted_at', null).order('label').order('id').range(from, to)),
    admin.from('twitter_groups').select('id,name').eq('organization_id', organizationId).is('deleted_at', null).order('name'),
    allRows((from, to) => admin.from('twitter_group_members').select('group_id,profile_id').eq('organization_id', organizationId).order('group_id').order('profile_id').range(from, to)),
  ]);
  if (profilesResult.error || connectionsResult.error || groupsResult.error || membersResult.error) {
    return NextResponse.json({ error: 'Não foi possível carregar os filtros locais do X.' }, { status: 503 });
  }

  const profiles = (profilesResult.data ?? []) as Profile[];
  const connections = (connectionsResult.data ?? []) as Connection[];
  const groups = (groupsResult.data ?? []) as Group[];
  const members = (membersResult.data ?? []) as Array<{ group_id: string; profile_id: string }>;
  const groupProfileIds = groupId ? new Set(members.filter((item) => item.group_id === groupId).map((item) => item.profile_id)) : null;
  const scopedProfiles = profiles.filter((profile) => (!connectionId || profile.current_connection_id === connectionId) && (!profileId || profile.id === profileId) && (!groupProfileIds || groupProfileIds.has(profile.id)));
  const scopedProfileIds = new Set(scopedProfiles.map((profile) => profile.id));
  const scopedProfileList = [...scopedProfileIds];

  const profileOptions = profiles.filter((profile) => (!connectionId || profile.current_connection_id === connectionId) && (!groupProfileIds || groupProfileIds.has(profile.id)));
  const empty = {
    summary: { followers: 0, followerDelta: 0, impressions: 0, views: 0, likes: 0, comments: 0, shares: 0, engagement: 0, engagementRate: 0, posts: 0, lastCapturedAt: null },
    coverage: { eligibleProfiles: 0, disabledProfiles: scopedProfiles.length, profilesWithData: 0, missingProfiles: scopedProfiles.length, pendingD1: 0, pendingD7: 0, pendingD30: 0 },
    followerSeries: [], ranking: [], topPosts: [],
    filters: { connections, profiles: profileOptions, groups },
    pagination: { page, limit, totalTopPosts: 0 }, source: 'local_snapshots', metric,
  };
  if (!scopedProfileList.length) return NextResponse.json(empty, { headers: { 'Cache-Control': 'private, no-store' } });

  // Projeções são opcionais durante o rollout. Relação ausente cai para snapshots brutos locais.
  const [followerProjection, postProjection, projectedPublications] = await Promise.all([
    allRows((from, to) => (admin.from('twitter_profile_follower_daily_metrics' as never) as any).select('profile_id,metric_date,followers_count,provider_updated_at,captured_at').eq('organization_id', organizationId).in('profile_id', scopedProfileList).lte('metric_date', end!).order('metric_date').range(from, to)),
    allRows((from, to) => (admin.from('twitter_post_analytics_current' as never) as any).select('publication_item_id,profile_id,collection_stage,impressions,views,likes,comments,shares,replies,bookmarks,quotes,provider_updated_at,captured_at,raw_metrics').eq('organization_id', organizationId).in('profile_id', scopedProfileList).range(from, to)),
    allRows((from, to) => admin.from('twitter_publication_items').select('id,profile_id,connection_id,content,execute_at').eq('organization_id', organizationId).in('profile_id', scopedProfileList).eq('status', 'published').gte('execute_at', `${start}T00:00:00.000Z`).lte('execute_at', `${end}T23:59:59.999Z`).order('execute_at').range(from, to) as any),
  ]);

  let followerPoints: FollowerPoint[] = [];
  let posts: PostMetric[] = [];
  let publications = (projectedPublications.data ?? []) as PostItem[];
  let source = 'typed_projections';
  let lastCapturedAt: string | null = null;

  if (!followerProjection.error && !postProjection.error && !projectedPublications.error) {
    followerPoints = followerProjection.data.map((row) => {
      const item = row as Json;
      const capturedAt = String(item.captured_at ?? '');
      if (capturedAt > (lastCapturedAt ?? '')) lastCapturedAt = capturedAt;
      return { profileId: String(item.profile_id), connectionId: profiles.find((profile) => profile.id === item.profile_id)?.current_connection_id ?? null, date: String(item.metric_date).slice(0, 10), followers: number(item.followers_count) };
    });
    const publicationById = new Map(publications.map((item) => [item.id, item]));
    posts = postProjection.data.filter((row) => publicationById.has(String((row as Json).publication_item_id))).map((row) => {
      const item = row as Json;
      const publication = publicationById.get(String(item.publication_item_id))!;
      const raw = object(item.raw_metrics);
      const platform = array(raw.platformAnalytics).map(object).find((value) => value.platform === 'twitter') ?? {};
      const interactions = number(item.likes) + number(item.comments) + number(item.shares) + number(item.replies) + number(item.bookmarks) + number(item.quotes);
      const capturedAt = String(item.captured_at ?? publication.execute_at ?? '');
      if (capturedAt > (lastCapturedAt ?? '')) lastCapturedAt = capturedAt;
      return { publicationItemId: String(item.publication_item_id), profileId: String(item.profile_id), connectionId: publication.connection_id, collectionStage: item.collection_stage ? String(item.collection_stage) : null, capturedAt, publishedAt: publication.execute_at, content: publication.content, url: typeof raw.platformPostUrl === 'string' ? raw.platformPostUrl : typeof platform.platformPostUrl === 'string' ? platform.platformPostUrl : null, impressions: number(item.impressions), views: number(item.views), likes: number(item.likes), comments: number(item.comments), shares: number(item.shares), engagement: interactions };
    });
  } else {
    source = 'local_snapshots';
    const [snapshotsResult, publicationResult] = await Promise.all([
      allRows((from, to) => admin.from('twitter_analytics_snapshots').select('id,resource_type,profile_id,publication_item_id,metrics,provider_updated_at,captured_at').eq('organization_id', organizationId).in('profile_id', scopedProfileList).order('captured_at').range(from, to) as any),
      allRows((from, to) => admin.from('twitter_publication_items').select('id,profile_id,connection_id,content,execute_at').eq('organization_id', organizationId).in('profile_id', scopedProfileList).eq('status', 'published').gte('execute_at', `${start}T00:00:00.000Z`).lte('execute_at', `${end}T23:59:59.999Z`).order('execute_at').range(from, to) as any),
    ]);
    if (snapshotsResult.error || publicationResult.error) return NextResponse.json({ error: 'Não foi possível carregar os analytics locais do X.' }, { status: 503 });
    const snapshots = snapshotsResult.data as Snapshot[];
    const publicationItems = publicationResult.data as PostItem[];
    publications = publicationItems;
    const publicationById = new Map(publicationItems.map((item) => [item.id, item]));
    for (const snapshot of snapshots) {
      if (snapshot.captured_at > (lastCapturedAt ?? '')) lastCapturedAt = snapshot.captured_at;
      const profile = profiles.find((item) => item.id === snapshot.profile_id);
      if (snapshot.resource_type === 'profile') {
        const stats = object(snapshot.metrics.stats);
        const series = Object.values(stats).flatMap(array).map(object);
        if (series.length) {
          for (const point of series) {
            const date = dateKey(point.date, snapshot.captured_at);
            if (date <= end!) followerPoints.push({ profileId: snapshot.profile_id, connectionId: profile?.current_connection_id ?? null, date, followers: number(point.followers) });
          }
        } else {
          const account = array(snapshot.metrics.accounts).map(object)[0] ?? {};
          const date = dateKey(snapshot.provider_updated_at, snapshot.captured_at);
          if (date <= end!) followerPoints.push({ profileId: snapshot.profile_id, connectionId: profile?.current_connection_id ?? null, date, followers: number(account.currentFollowers ?? snapshot.metrics.followers ?? snapshot.metrics.followers_count) });
        }
        continue;
      }
      const publication = snapshot.publication_item_id ? publicationById.get(snapshot.publication_item_id) : undefined;
      if (!publication || !snapshot.publication_item_id) continue;
      const values = postPayload(snapshot.metrics);
      const platform = array(snapshot.metrics.platformAnalytics).map(object).find((item) => item.platform === 'twitter') ?? {};
      const interactions = number(values.likes) + number(values.comments) + number(values.shares) + number(values.replies) + number(values.bookmarks) + number(values.quotes);
      posts.push({ publicationItemId: snapshot.publication_item_id, profileId: snapshot.profile_id, connectionId: publication.connection_id, collectionStage: null, capturedAt: snapshot.captured_at, publishedAt: publication.execute_at, content: String(snapshot.metrics.content ?? publication.content ?? ''), url: typeof snapshot.metrics.platformPostUrl === 'string' ? snapshot.metrics.platformPostUrl : typeof platform.platformPostUrl === 'string' ? platform.platformPostUrl : null, impressions: number(values.impressions), views: number(values.views), likes: number(values.likes), comments: number(values.comments), shares: number(values.shares), engagement: interactions });
    }
  }

  const latestFollowers = new Map<string, FollowerPoint>();
  const baselineFollowers = new Map<string, FollowerPoint>();
  const dailyFollowers = new Map<string, Map<string, FollowerPoint>>();
  for (const point of followerPoints.sort((a, b) => a.date.localeCompare(b.date))) {
    if (point.date < start! || !baselineFollowers.has(point.profileId)) baselineFollowers.set(point.profileId, point);
    latestFollowers.set(point.profileId, point);
    if (point.date < start!) continue;
    const daily = dailyFollowers.get(point.date) ?? new Map<string, FollowerPoint>();
    daily.set(point.profileId, point);
    dailyFollowers.set(point.date, daily);
  }
  const latestPosts = new Map<string, PostMetric>();
  for (const post of posts) {
    const current = latestPosts.get(post.publicationItemId);
    if (!current || post.capturedAt > current.capturedAt) latestPosts.set(post.publicationItemId, post);
  }
  const currentPosts = [...latestPosts.values()];
  const totals = currentPosts.reduce((sum, post) => ({ impressions: sum.impressions + post.impressions, views: sum.views + post.views, likes: sum.likes + post.likes, comments: sum.comments + post.comments, shares: sum.shares + post.shares, engagement: sum.engagement + post.engagement }), { impressions: 0, views: 0, likes: 0, comments: 0, shares: 0, engagement: 0 });
  const followers = [...latestFollowers.values()].reduce((sum, point) => sum + point.followers, 0);
  const followerDelta = [...latestFollowers.entries()].reduce((sum, [id, point]) => sum + point.followers - (baselineFollowers.get(id)?.followers ?? point.followers), 0);
  const carriedFollowers = new Map<string, FollowerPoint>();
  baselineFollowers.forEach((point, id) => { if (point.date < start!) carriedFollowers.set(id, point); });
  const followerSeries = [...dailyFollowers.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, values]) => {
    values.forEach((point, id) => carriedFollowers.set(id, point));
    return { date, followers: [...carriedFollowers.values()].reduce((sum, point) => sum + point.followers, 0) };
  });
  const profileTotals = new Map<string, number>();
  currentPosts.forEach((post) => profileTotals.set(post.profileId, (profileTotals.get(post.profileId) ?? 0) + metricValue(post, metric)));
  const ranking = scopedProfiles.map((profile) => ({ profileId: profile.id, username: profile.username, displayName: profile.display_name, avatarUrl: profile.avatar_url, value: profileTotals.get(profile.id) ?? 0, followers: latestFollowers.get(profile.id)?.followers ?? 0 })).sort((a, b) => b.value - a.value || b.followers - a.followers).slice(0, 20);
  const rankedPosts = currentPosts.sort((a, b) => metricValue(b, metric) - metricValue(a, metric) || b.engagement - a.engagement);
  const topPosts = rankedPosts.slice((page - 1) * limit, page * limit).map((post) => ({ ...post, value: metricValue(post, metric), username: profiles.find((profile) => profile.id === post.profileId)?.username ?? '' }));

  const enabledConnections = new Set(connections.filter((connection) => connection.analytics_enabled && connection.status !== 'deleted').map((connection) => connection.id));
  const eligibleProfiles = scopedProfiles.filter((profile) => profile.analytics_enabled && profile.can_fetch_analytics && profile.status === 'active' && Boolean(profile.current_connection_id && enabledConnections.has(profile.current_connection_id)));
  const profilesWithData = new Set([...latestFollowers.keys(), ...currentPosts.map((post) => post.profileId)]);
  const eligibleProfileIds = new Set(eligibleProfiles.map((profile) => profile.id));
  const eligibleProfilesWithData = [...profilesWithData].filter((id) => eligibleProfileIds.has(id)).length;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const todayMs = Date.parse(`${today}T12:00:00Z`);
  const pending = { d1: 0, d7: 0, d30: 0 };
  const postStage = new Map(currentPosts.map((post) => [post.publicationItemId, post.collectionStage]));
  publications.forEach((post) => {
    const age = Math.floor((todayMs - Date.parse(`${post.execute_at.slice(0, 10)}T12:00:00Z`)) / 86400000);
    const stage = postStage.get(post.id);
    if (age >= 30 && !['d30', 'forced'].includes(stage ?? '')) pending.d30 += 1;
    else if (age >= 7 && !['d7', 'd30', 'forced'].includes(stage ?? '')) pending.d7 += 1;
    else if (age >= 1 && !stage) pending.d1 += 1;
  });

  return NextResponse.json({
    summary: { followers, followerDelta, ...totals, engagementRate: totals.impressions > 0 ? (totals.engagement / totals.impressions) * 100 : 0, posts: currentPosts.length, lastCapturedAt },
    coverage: { eligibleProfiles: eligibleProfiles.length, disabledProfiles: scopedProfiles.length - eligibleProfiles.length, profilesWithData: eligibleProfilesWithData, missingProfiles: Math.max(0, eligibleProfiles.length - eligibleProfilesWithData), pendingD1: pending.d1, pendingD7: pending.d7, pendingD30: pending.d30 },
    followerSeries, ranking, topPosts,
    filters: { connections, profiles: profileOptions, groups },
    pagination: { page, limit, totalTopPosts: rankedPosts.length }, source, metric,
  }, { headers: { 'Cache-Control': 'private, no-store' } });
}
