#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

function environment() {
  const values = { ...process.env };
  for (const file of ['.env.worker.deploy', '.env.worker', '.env.local']) {
    if (!existsSync(file)) continue;
    for (const source of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = source.trim(); const index = line.indexOf('=');
      if (!line || line.startsWith('#') || index < 1) continue;
      const key = line.slice(0, index).trim();
      if (!values[key]) values[key] = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return values;
}

const env = environment();
if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Credenciais Supabase ausentes.');
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const output = process.env.DASHBOARD_POSTS_AUDIT_OUTPUT ?? 'dashboard-posts-audit.json';
const saoPauloDateKey = (date = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(date);
const shiftDateKey = (dateKey, days) => {
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
const today = saoPauloDateKey();
const yesterday = shiftDateKey(today, -1);
const todayStartIso = `${today}T00:00:00-03:00`;
const yesterdayStartIso = `${yesterday}T00:00:00-03:00`;
const [recentItems, publishedItems, snapshots, publishedItemsTodayCount, postSnapshotsTotal, recentPostSnapshots] = await Promise.all([
  supabase.from('publication_items').select('id, organization_id, profile_id, status, execute_at, published_at, created_at, updated_at').gte('updated_at', yesterdayStartIso).order('updated_at', { ascending: false }).limit(10000),
  supabase.from('publication_items').select('id, organization_id, profile_id, status, execute_at, published_at, created_at, updated_at').eq('status', 'published').gte('published_at', yesterdayStartIso).order('published_at', { ascending: false }).limit(10000),
  supabase.from('profile_post_analytics_snapshots').select('id, organization_id, profile_id, published_at, synced_at, sync_status, views, likes, comments, shares, saves, total_interactions').gte('published_at', yesterdayStartIso).is('deleted_at', null).order('published_at', { ascending: false }).limit(10000),
  supabase.from('publication_items').select('*', { count: 'exact', head: true }).eq('status', 'published').gte('published_at', todayStartIso),
  supabase.from('profile_post_analytics_snapshots').select('*', { count: 'exact', head: true }).is('deleted_at', null),
  supabase.from('profile_post_analytics_snapshots').select('id, organization_id, profile_id, published_at, synced_at, sync_status, views, likes, comments, shares, saves, total_interactions').gte('synced_at', yesterdayStartIso).is('deleted_at', null).order('synced_at', { ascending: false }).limit(1000),
]);
if (recentItems.error || publishedItems.error || snapshots.error || publishedItemsTodayCount.error || postSnapshotsTotal.error || recentPostSnapshots.error) {
  throw recentItems.error ?? publishedItems.error ?? snapshots.error ?? publishedItemsTodayCount.error ?? postSnapshotsTotal.error ?? recentPostSnapshots.error;
}
const countBy = (rows, key) => rows.reduce((totals, row) => {
  const value = key(row);
  totals[value] = (totals[value] ?? 0) + 1;
  return totals;
}, {});
const report = {
  generatedAt: new Date().toISOString(),
  saoPaulo: { today, todayStartIso, yesterdayStartIso },
  recentPublicationItemsByStatus: countBy(recentItems.data ?? [], (item) => item.status),
  publishedItemsBySaoPauloDay: countBy(publishedItems.data ?? [], (item) => saoPauloDateKey(new Date(item.published_at))),
  publishedItemsTodayDatabaseCount: publishedItemsTodayCount.count ?? 0,
  publishedItemsByOrganizationInSample: countBy(publishedItems.data ?? [], (item) => item.organization_id),
  publishedItemsToday: (publishedItems.data ?? []).filter((item) => item.published_at >= todayStartIso),
  publishedItemsWithoutPublishedAt: (recentItems.data ?? []).filter((item) => item.status === 'published' && !item.published_at),
  postSnapshotsDatabaseCount: postSnapshotsTotal.count ?? 0,
  recentPostSnapshots: (snapshots.data ?? []).length,
  snapshotsSyncedSinceYesterday: (recentPostSnapshots.data ?? []).length,
  postSnapshotsWithPublishedAt: (snapshots.data ?? []).filter((item) => item.published_at).length,
  postSnapshotsBySaoPauloDay: countBy(snapshots.data ?? [], (item) => saoPauloDateKey(new Date(item.published_at))),
  postSnapshotsToday: (snapshots.data ?? []).filter((item) => item.published_at >= todayStartIso),
  samples: {
    recentPublicationItems: (recentItems.data ?? []).slice(0, 30),
    publishedItems: (publishedItems.data ?? []).slice(0, 30),
    postSnapshots: (snapshots.data ?? []).slice(0, 30),
  },
};
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.info(JSON.stringify({ output, saoPaulo: report.saoPaulo, recentPublicationItemsByStatus: report.recentPublicationItemsByStatus, publishedItemsBySaoPauloDay: report.publishedItemsBySaoPauloDay, publishedItemsTodayDatabaseCount: report.publishedItemsTodayDatabaseCount, publishedItemsByOrganizationInSample: report.publishedItemsByOrganizationInSample, publishedItemsToday: report.publishedItemsToday.length, publicationItemsWithoutPublishedAt: report.publishedItemsWithoutPublishedAt.length, postSnapshotsDatabaseCount: report.postSnapshotsDatabaseCount, recentPostSnapshots: report.recentPostSnapshots, snapshotsSyncedSinceYesterday: report.snapshotsSyncedSinceYesterday, postSnapshotsWithPublishedAt: report.postSnapshotsWithPublishedAt, postSnapshotsBySaoPauloDay: report.postSnapshotsBySaoPauloDay, postSnapshotsToday: report.postSnapshotsToday.length }, null, 2));
