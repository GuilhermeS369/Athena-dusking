#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

for (const filePath of ['.env.local', '.env.worker.deploy']) {
  if (!fs.existsSync(filePath)) continue;
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const separator = rawLine.indexOf('=');
    if (separator <= 0 || rawLine.trim().startsWith('#')) continue;
    const key = rawLine.slice(0, separator).trim();
    if (process.env[key]) continue;
    process.env[key] = rawLine.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
  }
}

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const organizationId = '695be08f-3084-4046-a91d-9052b2a1582b';
const profileId = '117bd916-fb13-4754-8178-fe0712832a55';
const { data: profile, error: profileError } = await supabase.from('instagram_profiles').select('*').eq('id', profileId).single();
if (profileError) throw profileError;
const row = {
  organization_id: organizationId,
  instagram_user_id: profile.instagram_user_id,
  username: profile.username,
  display_name: profile.display_name,
  profile_picture_url: profile.profile_picture_url,
  account_type: profile.account_type,
  capabilities: profile.capabilities,
  status: profile.status,
  created_by: profile.created_by,
  provider: 'zernio',
  zernio_profile_id: profile.zernio_profile_id,
  zernio_account_id: profile.zernio_account_id,
  zernio_connection_id: profile.zernio_connection_id,
  zernio_account_metadata: profile.zernio_account_metadata,
};
const { data, error } = await supabase.rpc('reconcile_zernio_connection_accounts', {
  p_organization_id: organizationId,
  p_zernio_connection_id: profile.zernio_connection_id,
  p_rows: [row],
});
if (error) throw error;
console.log(JSON.stringify({ profileId, reconciliation: data }, null, 2));
