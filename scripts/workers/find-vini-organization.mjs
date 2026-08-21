#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

for (const filePath of ['.env.local', '.env.worker.deploy']) {
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

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const { data: organizations, error: organizationsError } = await supabase
  .from('organizations')
  .select('id, name, created_at')
  .order('name');
if (organizationsError) throw organizationsError;

const { data: authData, error: authError } = await supabase.auth.admin.listUsers({
  page: 1,
  perPage: 1000,
});
if (authError) throw authError;

const userMatches = authData.users.filter((user) => {
  const serialized = JSON.stringify({
    email: user.email,
    user_metadata: user.user_metadata,
    app_metadata: user.app_metadata,
  }).toLocaleLowerCase('pt-BR');
  return serialized.includes('vini') || serialized.includes('farmando') || serialized.includes('cash');
});

const memberships = userMatches.length
  ? await supabase
    .from('organization_members')
    .select('user_id, organization_id, role, organizations(id, name)')
    .in('user_id', userMatches.map((user) => user.id))
  : { data: [], error: null };
if (memberships.error) throw memberships.error;

const organizationMatches = (organizations ?? []).filter((organization) => {
  const name = organization.name.toLocaleLowerCase('pt-BR');
  return name.includes('vini') || name.includes('farmando') || name.includes('cash');
});

console.log(JSON.stringify({
  organizationMatches,
  userMatches: userMatches.map((user) => ({
    id: user.id,
    email: user.email,
    name: user.user_metadata?.name ?? user.user_metadata?.full_name ?? null,
  })),
  memberships: memberships.data ?? [],
  organizations: organizations ?? [],
}, null, 2));
