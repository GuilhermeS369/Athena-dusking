#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

for (const filePath of ['.env.local', '.env.worker', '.env.worker.deploy']) {
  if (!fs.existsSync(filePath)) continue;
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (process.env[key]) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

const organizationId = process.argv.find((argument) => argument.startsWith('--organization-id='))?.slice('--organization-id='.length);
if (!organizationId) throw new Error('Informe --organization-id=<uuid>.');
if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Credenciais do Supabase não encontradas.');

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const now = new Date().toISOString();
const horizonEnd = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
const [profilesResult, itemsResult, groupsResult] = await Promise.all([
  supabase
    .from('instagram_profiles')
    .select('id, username')
    .eq('organization_id', organizationId)
    .is('deleted_at', null),
  supabase
    .from('publication_items')
    .select('profile_id, format, status, execute_at')
    .eq('organization_id', organizationId)
    .or(`status.eq.published,and(status.in.(waiting,ready,preparing,publishing),or(execute_at.is.null,execute_at.gt.${now}))`),
  supabase
    .from('profile_groups')
    .select('id, name, profile_group_members(profile_id)')
    .eq('organization_id', organizationId)
    .ilike('name', '%miguel%')
    .is('deleted_at', null),
]);
if (profilesResult.error || itemsResult.error || groupsResult.error) throw profilesResult.error ?? itemsResult.error ?? groupsResult.error;

const rows = (profilesResult.data ?? []).map((profile) => ({
  profile_id: profile.id,
  username: profile.username,
  scheduled_counts: { reel: 0, story: 0, image: 0, carousel: 0 },
  published_counts: { reel: 0, story: 0, image: 0, carousel: 0 },
  scheduled_execute_ats_by_format: { reel: [], story: [], image: [], carousel: [] },
}));
const rowsByProfileId = new Map(rows.map((row) => [row.profile_id, row]));
for (const item of itemsResult.data ?? []) {
  if (!['reel', 'story', 'image', 'carousel'].includes(item.format)) continue;
  const row = rowsByProfileId.get(item.profile_id);
  if (!row) continue;
  if (item.status === 'published') row.published_counts[item.format] += 1;
  else {
    row.scheduled_counts[item.format] += 1;
    if (item.execute_at && item.execute_at <= horizonEnd) row.scheduled_execute_ats_by_format[item.format].push(item.execute_at);
  }
}
const composerMetricsResult = await supabase.rpc('get_posting_composer_profile_metrics', {
  p_organization_id: organizationId,
  p_slot_horizon_days: 90,
});
const rpcRowsByProfileId = new Map((composerMetricsResult.data ?? []).map((row) => [row.profile_id, row]));
const count = (field, format) => rows.reduce((sum, row) => sum + Number(row[field]?.[format] ?? 0), 0);
const profilesWithItems = (format) => rows.filter((row) => (
  Number(row.scheduled_counts?.[format] ?? 0) + Number(row.published_counts?.[format] ?? 0) > 0
)).length;
const usernameByProfileId = new Map((profilesResult.data ?? []).map((profile) => [profile.id, profile.username]));
const groups = (groupsResult.data ?? []).map((group) => {
  const memberIds = new Set((group.profile_group_members ?? []).map((member) => member.profile_id));
  const members = rows.filter((row) => memberIds.has(row.profile_id));
  return {
    name: group.name,
    memberCount: memberIds.size,
    reel: {
      scheduled: members.reduce((sum, row) => sum + row.scheduled_counts.reel, 0),
      published: members.reduce((sum, row) => sum + row.published_counts.reel, 0),
      profilesWithItems: members.filter((row) => row.scheduled_counts.reel + row.published_counts.reel > 0).length,
    },
    story: {
      scheduled: members.reduce((sum, row) => sum + row.scheduled_counts.story, 0),
      published: members.reduce((sum, row) => sum + row.published_counts.story, 0),
      profilesWithItems: members.filter((row) => row.scheduled_counts.story + row.published_counts.story > 0).length,
    },
    nonZeroMembers: members.filter((row) => row.scheduled_counts.reel + row.published_counts.reel + row.scheduled_counts.story + row.published_counts.story > 0).map((row) => ({
      username: usernameByProfileId.get(row.profile_id),
      reel: { scheduled: row.scheduled_counts.reel, published: row.published_counts.reel },
      story: { scheduled: row.scheduled_counts.story, published: row.published_counts.story },
    })),
  };
});

console.log(JSON.stringify({
  checkedAt: new Date().toISOString(),
  rowCount: rows.length,
  formats: Object.fromEntries(['reel', 'story', 'image', 'carousel'].map((format) => [format, {
    scheduled: count('scheduled_counts', format),
    published: count('published_counts', format),
    profilesWithItems: profilesWithItems(format),
  }])),
  composerRpc: composerMetricsResult.error ? {
    error: { code: composerMetricsResult.error.code, message: composerMetricsResult.error.message },
  } : {
    rowCount: composerMetricsResult.data?.length ?? 0,
    groups: (groupsResult.data ?? []).map((group) => {
      const memberIds = (group.profile_group_members ?? []).map((member) => member.profile_id);
      const metrics = memberIds.map((profileId) => rpcRowsByProfileId.get(profileId)).filter(Boolean);
      return {
        name: group.name,
        memberCount: memberIds.length,
        reel: {
          scheduled: metrics.reduce((sum, row) => sum + Number(row.scheduled_counts?.reel ?? 0), 0),
          published: metrics.reduce((sum, row) => sum + Number(row.published_counts?.reel ?? 0), 0),
          profilesWithItems: metrics.filter((row) => Number(row.scheduled_counts?.reel ?? 0) + Number(row.published_counts?.reel ?? 0) > 0).length,
        },
      };
    }),
    inspectedProfiles: (profilesResult.data ?? [])
      .filter((profile) => ['zoe9383042', 'zhen70463', 'zoe375950'].includes(profile.username))
      .map((profile) => ({ username: profile.username, metric: rpcRowsByProfileId.get(profile.id) ?? null })),
  },
  groups,
  samples: rows.filter((row) => (
    Number(row.scheduled_counts?.reel ?? 0) > 0 || Number(row.scheduled_counts?.story ?? 0) > 0
  )).slice(0, 20),
}, null, 2));
