#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

const usernames = [
  'brittany805547',
  'tameka86601',
  'hevinkole084',
  'jordyn26786',
  'rapiddragonbn41',
  'patrickstonefield43',
  'francesca_dorsey',
  'emmalynn.tate',
  'isaias115128',
  'kendra900137',
];

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

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) throw new Error('Credenciais do Supabase não encontradas.');

const supabase = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
const { data: profiles, error: profilesError } = await supabase
  .from('instagram_profiles')
  .select('id, username')
  .in('username', usernames);
if (profilesError) throw profilesError;

const profileIds = (profiles ?? []).map((profile) => profile.id);
const { data: planProfiles, error: planProfilesError } = profileIds.length
  ? await supabase
    .from('bulk_publication_plan_profiles')
    .select('profile_id, plan_id, status, first_execute_at, last_execute_at')
    .in('profile_id', profileIds)
  : { data: [], error: null };
if (planProfilesError) throw planProfilesError;

const planIds = [...new Set((planProfiles ?? []).map((profilePlan) => profilePlan.plan_id))];
const { data: reelPlans, error: reelPlansError } = planIds.length
  ? await supabase
    .from('bulk_publication_plans')
    .select('id, name, status, interval_minutes, created_at, updated_at')
    .in('id', planIds)
    .eq('format', 'reel')
  : { data: [], error: null };
if (reelPlansError) throw reelPlansError;

const profileByUsername = new Map((profiles ?? []).map((profile) => [profile.username, profile]));
const reelPlanById = new Map((reelPlans ?? []).map((plan) => [plan.id, plan]));
const result = usernames.map((username) => {
  const profile = profileByUsername.get(username);
  const plans = profile
    ? (planProfiles ?? [])
      .filter((profilePlan) => profilePlan.profile_id === profile.id && reelPlanById.has(profilePlan.plan_id))
      .map((profilePlan) => ({ ...reelPlanById.get(profilePlan.plan_id), profilePlanStatus: profilePlan.status }))
      .sort((left, right) => new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime())
    : [];

  return { username, intervaloMinutosDoReelMaisRecente: plans[0]?.interval_minutes ?? null, planosDeReel: plans };
});

console.log(JSON.stringify({ consultadoEm: new Date().toISOString(), perfis: result }, null, 2));
