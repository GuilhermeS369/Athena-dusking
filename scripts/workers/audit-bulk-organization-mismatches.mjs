#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

for (const filePath of ['.env.local', '.env.worker', '.env.worker.deploy']) {
  if (!fs.existsSync(filePath)) continue;
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    const separator = line.indexOf('=');
    if (!line || line.startsWith('#') || separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (process.env[key]) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const [{ data: planProfiles, error: planProfilesError }, { data: plans, error: plansError }, { data: profiles, error: profilesError }] = await Promise.all([
  supabase.from('bulk_publication_plan_profiles').select('id, plan_id, profile_id, organization_id, status, failed_slot_count').in('status', ['queued', 'generating', 'failed', 'suspended']),
  supabase.from('bulk_publication_plans').select('id, name, organization_id, status').in('status', ['queued', 'generating', 'completed_with_errors', 'paused']),
  supabase.from('instagram_profiles').select('id, username, organization_id, status, deleted_at'),
]);
if (planProfilesError || plansError || profilesError) throw planProfilesError ?? plansError ?? profilesError;

const plansById = new Map(plans.map((plan) => [plan.id, plan]));
const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
const mismatches = planProfiles.flatMap((planProfile) => {
  const plan = plansById.get(planProfile.plan_id);
  const profile = profilesById.get(planProfile.profile_id);
  if (!plan || !profile || (plan.organization_id === planProfile.organization_id && profile.organization_id === planProfile.organization_id)) return [];
  return [{ plan, planProfile, profile }];
});

console.log(JSON.stringify({
  checkedAt: new Date().toISOString(),
  activePlanProfileCount: planProfiles.length,
  activePlanCount: plans.length,
  mismatchCount: mismatches.length,
  mismatches,
}, null, 2));
