#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

const usernames = [
  'marinhojoilma476',
  'ketlen.salgueiro170',
  'christiane.mesquita195',
  'grazielacutrim88',
  '_genildapassos533',
  'andradeester583',
];

for (const filePath of ['.env.local', '.env.worker.deploy']) {
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
if (!url || !serviceRoleKey) throw new Error('Credenciais Supabase ausentes.');
const supabase = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

const apply = process.argv.includes('--apply');
const report = process.argv.includes('--report');
if (report) {
  const { data, error } = await supabase
    .from('zernio_profile_disconnection_incidents')
    .select('username_snapshot, zernio_connection_id, state, remote_result, remote_http_status, finalized_at, created_at')
    .eq('source', 'historical_backfill')
    .in('username_snapshot', usernames)
    .order('username_snapshot');
  if (error) throw error;
  console.log(JSON.stringify({ mode: 'report', incidents: data ?? [] }, null, 2));
  process.exit(0);
}

if (!apply) {
  const { data, error } = await supabase
    .from('instagram_profiles')
    .select('id, username, organization_id, zernio_connection_id, zernio_account_id, deleted_at')
    .eq('provider', 'zernio')
    .in('username', usernames);
  if (error) throw error;
  console.log(JSON.stringify({ mode: 'dry-run', foundProfiles: data?.map(({ zernio_account_id: _, ...profile }) => profile) ?? [], requestedUsernames: usernames }, null, 2));
  process.exit(0);
}

const { data, error } = await supabase.rpc('schedule_historical_zernio_profile_disconnections', { p_usernames: usernames });
if (error) throw error;
console.log(JSON.stringify({ mode: 'apply', results: data ?? [] }, null, 2));
