import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Credenciais Supabase ausentes.');

const database = createClient(url, key, { auth: { persistSession: false } });
const { data: organizations, error: organizationsError } = await database.from('organizations').select('id,name,slug').order('name');
if (organizationsError) throw organizationsError;

for (const organization of organizations ?? []) {
  const [profilesResult, snapshotsResult, followersResult, postsResult] = await Promise.all([
    database.from('instagram_profiles').select('id,username,provider,status').eq('organization_id', organization.id).is('deleted_at', null),
    database.from('profile_analytics_snapshots').select('profile_id,period_start,period_end,followers_count,reach,likes,total_interactions,posts_count,sync_status,synced_at,raw_payload').eq('organization_id', organization.id).is('deleted_at', null).order('synced_at', { ascending: false }).limit(1000),
    database.from('profile_follower_daily_snapshots').select('*', { count: 'exact', head: true }).eq('organization_id', organization.id).is('deleted_at', null),
    database.from('profile_post_analytics_snapshots').select('*', { count: 'exact', head: true }).eq('organization_id', organization.id).is('deleted_at', null),
  ]);

  const errors = [profilesResult.error, snapshotsResult.error, followersResult.error, postsResult.error].filter(Boolean);
  if (errors.length > 0) {
    console.log(JSON.stringify({ organization: organization.name, errors: errors.map((error) => error.message) }, null, 2));
    continue;
  }

  const snapshots = snapshotsResult.data ?? [];
  const activeProfileIds = new Set((profilesResult.data ?? []).map((profile) => profile.id));
  const activeSnapshots = snapshots.filter((snapshot) => activeProfileIds.has(snapshot.profile_id));
  const latest = new Map();
  for (const snapshot of activeSnapshots) if (!latest.has(snapshot.profile_id)) latest.set(snapshot.profile_id, snapshot);
  const latestUsable = new Map();
  for (const snapshot of activeSnapshots) {
    if (snapshot.sync_status !== 'failed' && !latestUsable.has(snapshot.profile_id)) latestUsable.set(snapshot.profile_id, snapshot);
  }
  const shapes = {};
  for (const snapshot of latest.values()) {
    const dailyMetrics = snapshot.raw_payload?.dailyMetrics;
    const dailyData = Array.isArray(dailyMetrics?.dailyData) ? dailyMetrics.dailyData : [];
    const shape = `${dailyMetrics === null ? 'null' : typeof dailyMetrics}:dailyData=${Array.isArray(dailyMetrics?.dailyData)}:rows=${dailyData.length}`;
    shapes[shape] = (shapes[shape] ?? 0) + 1;
  }

  console.log(JSON.stringify({
    organization: organization.name,
    slug: organization.slug,
    profiles: profilesResult.data?.length ?? 0,
    snapshots: snapshots.length,
    activeSnapshots: activeSnapshots.length,
    latestSnapshots: latest.size,
    followerRows: followersResult.count ?? 0,
    postRows: postsResult.count ?? 0,
    latestStatuses: [...latest.values()].reduce((statuses, snapshot) => {
      statuses[snapshot.sync_status] = (statuses[snapshot.sync_status] ?? 0) + 1;
      return statuses;
    }, {}),
    latestTotals: [...latest.values()].reduce((totals, snapshot) => ({
      followers: totals.followers + snapshot.followers_count,
      reach: totals.reach + snapshot.reach,
      likes: totals.likes + snapshot.likes,
      interactions: totals.interactions + snapshot.total_interactions,
      posts: totals.posts + snapshot.posts_count,
    }), { followers: 0, reach: 0, likes: 0, interactions: 0, posts: 0 }),
    latestUsableTotals: [...latestUsable.values()].reduce((totals, snapshot) => ({
      followers: totals.followers + snapshot.followers_count,
      reach: totals.reach + snapshot.reach,
      likes: totals.likes + snapshot.likes,
      interactions: totals.interactions + snapshot.total_interactions,
      posts: totals.posts + snapshot.posts_count,
    }), { followers: 0, reach: 0, likes: 0, interactions: 0, posts: 0 }),
    profileExamples: (profilesResult.data ?? []).slice(0, 10).map((profile) => ({
      username: profile.username,
      current: latest.get(profile.id) ? {
        status: latest.get(profile.id).sync_status,
        sync: latest.get(profile.id).synced_at,
        followers: latest.get(profile.id).followers_count,
        reach: latest.get(profile.id).reach,
        likes: latest.get(profile.id).likes,
      } : null,
      usable: latestUsable.get(profile.id) ? {
        status: latestUsable.get(profile.id).sync_status,
        sync: latestUsable.get(profile.id).synced_at,
        followers: latestUsable.get(profile.id).followers_count,
        reach: latestUsable.get(profile.id).reach,
        likes: latestUsable.get(profile.id).likes,
      } : null,
    })),
    dailyPayloadShapes: shapes,
    usablePeriodRanges: [...latestUsable.values()].reduce((ranges, snapshot) => {
      const key = `${snapshot.period_start}..${snapshot.period_end}`;
      ranges[key] = (ranges[key] ?? 0) + 1;
      return ranges;
    }, {}),
    newestSync: snapshots[0]?.synced_at ?? null,
  }, null, 2));
}
