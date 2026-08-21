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

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
};

const organizationId = process.env.BULK_DAILY_ORGANIZATION_ID;
const accessToken = process.env.BULK_DAILY_ACCESS_TOKEN;
if (!organizationId || !accessToken) {
  throw new Error('Defina BULK_DAILY_ORGANIZATION_ID e BULK_DAILY_ACCESS_TOKEN; o script apenas revisa a programação, sem criar lote.');
}

const service = createClient(required('NEXT_PUBLIC_SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { autoRefreshToken: false, persistSession: false },
});
const authenticated = createClient(required('NEXT_PUBLIC_SUPABASE_URL'), required('NEXT_PUBLIC_SUPABASE_ANON_KEY'), {
  auth: { autoRefreshToken: false, persistSession: false },
  global: { headers: { Authorization: `Bearer ${accessToken}` } },
});

const [{ data: userData, error: userError }, { data: profiles, error: profilesError }] = await Promise.all([
  authenticated.auth.getUser(accessToken),
  service.from('instagram_profiles').select('id, username, status').eq('organization_id', organizationId).eq('status', 'online').is('deleted_at', null).order('username').limit(89),
]);
if (userError || !userData.user) throw new Error('Token de acesso inválido ou expirado.');
if (profilesError) throw profilesError;
if (!profiles?.length) throw new Error('Nenhum perfil online localizado.');

const { data, error } = await authenticated.rpc('review_bulk_daily_rotation_schedule', {
  p_organization_id: organizationId,
  p_profile_ids: profiles.map((profile) => profile.id),
  p_repeat_days: 2,
  p_daily_time: '07:00',
});

console.log(JSON.stringify({
  checkedAt: new Date().toISOString(),
  organizationId,
  userId: userData.user.id,
  profileCount: profiles.length,
  schedule: data ?? null,
  error: error ? { code: error.code, message: error.message, details: error.details, hint: error.hint } : null,
}, null, 2));
process.exitCode = error ? 1 : 0;
