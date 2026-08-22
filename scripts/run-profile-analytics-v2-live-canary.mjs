import fs from 'node:fs';
import process from 'node:process';

import { createClient } from '@supabase/supabase-js';

for (const filePath of ['.env.local', '.env.worker']) {
  if (!fs.existsSync(filePath)) continue;
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const separator = rawLine.indexOf('=');
    if (separator <= 0 || rawLine.trim().startsWith('#')) continue;
    const key = rawLine.slice(0, separator).trim();
    if (process.env[key]) continue;
    process.env[key] = rawLine.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
  }
}

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
};

const sourceClass = required('PROFILE_ANALYTICS_V2_CANARY_SOURCE_CLASS').toLowerCase();
if (!['current', 'daily', 'posts'].includes(sourceClass)) {
  throw new Error('PROFILE_ANALYTICS_V2_CANARY_SOURCE_CLASS deve ser current, daily ou posts.');
}
const organizationId = required('PROFILE_ANALYTICS_V2_CANARY_ORGANIZATION_ID');
const profileIds = required('PROFILE_ANALYTICS_V2_CANARY_PROFILE_IDS').split(',').map((value) => value.trim()).filter(Boolean);
const canaryKey = required('PROFILE_ANALYTICS_V2_CANARY_KEY');
const supabase = createClient(required('NEXT_PUBLIC_SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data, error } = await supabase.rpc('enqueue_profile_analytics_refresh_v2_live_canary', {
  p_organization_id: organizationId,
  p_profile_ids: profileIds,
  p_source_class: sourceClass,
  p_canary_key: canaryKey,
});
if (error) throw error;
console.log(JSON.stringify({ organizationId, profileIds, sourceClass, canaryKey, result: data }, null, 2));
