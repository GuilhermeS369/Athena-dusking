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

const organizationId = required('PROFILE_ANALYTICS_BACKFILL_ORGANIZATION_ID');
const supabase = createClient(required('NEXT_PUBLIC_SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { autoRefreshToken: false, persistSession: false },
});

let cursor = null;
let totalProcessed = 0;
const batches = [];
do {
  const { data, error } = await supabase.rpc('backfill_profile_analytics_current_placeholders', {
    p_organization_id: organizationId,
    p_limit: 500,
    p_after_profile_id: cursor,
  });
  if (error) throw error;
  const result = data?.[0] ?? {};
  batches.push(result);
  totalProcessed += result.processed_count ?? 0;
  cursor = result.last_profile_id ?? null;
  if (!result.has_more) break;
} while (cursor);

const [activeResult, currentResult, parityResult] = await Promise.all([
  supabase.from('instagram_profiles').select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId).is('deleted_at', null),
  supabase.from('profile_analytics_current').select('profile_id', { count: 'exact', head: true })
    .eq('organization_id', organizationId).is('deleted_at', null),
  supabase.rpc('audit_profile_analytics_current_parity', { p_organization_id: organizationId }),
]);
if (activeResult.error || currentResult.error || parityResult.error) {
  throw activeResult.error ?? currentResult.error ?? parityResult.error;
}

console.log(JSON.stringify({
  organizationId,
  totalProcessed,
  batches,
  activeProfiles: activeResult.count,
  currentRows: currentResult.count,
  parity: parityResult.data,
}, null, 2));
