import fs from 'node:fs';
import process from 'node:process';
import { performance } from 'node:perf_hooks';

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
const organizationId = required('PROFILE_ANALYTICS_ROLLOUT_ORGANIZATION_ID');
const enabled = required('PROFILE_ANALYTICS_ROLLOUT_CURRENT_STATE_ENABLED') === 'true';
const supabase = createClient(required('NEXT_PUBLIC_SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function bootstrap() {
  const startedAt = performance.now();
  const { data, error } = await supabase.rpc('get_dashboard_bootstrap_v2', {
    p_organization_id: organizationId,
  });
  if (error) throw error;
  return {
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    stateSource: data?.state_source,
    profileCount: data?.profiles?.length ?? 0,
    analyticsStateCount: data?.analytics_state?.length ?? 0,
    summary: data?.summary ?? {},
  };
}

const before = await bootstrap();
const { data: rolloutBefore, error: rolloutReadError } = await supabase
  .from('profile_analytics_v2_rollouts')
  .select('*')
  .eq('organization_id', organizationId)
  .maybeSingle();
if (rolloutReadError) throw rolloutReadError;

const { error: rolloutError } = await supabase.from('profile_analytics_v2_rollouts').upsert({
  ...(rolloutBefore ?? {}),
  organization_id: organizationId,
  current_state_reads_enabled: enabled,
  legacy_fallback_enabled: true,
  metadata: {
    ...(rolloutBefore?.metadata ?? {}),
    phaseFCurrentStateRolloutAt: new Date().toISOString(),
    phaseFCurrentStateEnabled: enabled,
  },
}, { onConflict: 'organization_id' });
if (rolloutError) throw rolloutError;

const after = await bootstrap();
console.log(JSON.stringify({ organizationId, enabled, rolloutBefore, before, after }, null, 2));
