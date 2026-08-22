import fs from 'node:fs';

import { createClient } from '@supabase/supabase-js';

for (const file of ['.env.local', '.env.worker.deploy', '.env.worker']) {
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
    }
  }
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Credenciais administrativas do Supabase ausentes.');

const database = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const organizationId = process.argv[2] ?? '58785306-4dfb-432f-8de0-f0b33f91f3de';
const now = new Date();
const endDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(now);
const start = new Date(`${endDate}T12:00:00Z`);
start.setUTCDate(start.getUTCDate() - 29);
const startDate = start.toISOString().slice(0, 10);

async function measure(name, operation) {
  const startedAt = performance.now();
  const { data, error } = await operation();
  const durationMs = Math.round(performance.now() - startedAt);
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return {
    name,
    durationMs,
    bytes: Buffer.byteLength(JSON.stringify(data ?? null)),
    rows: Array.isArray(data) ? data.length : 1,
    data,
  };
}

const bootstrap = await measure('bootstrap', () => database.rpc('get_dashboard_bootstrap_v2', {
  p_organization_id: organizationId,
}));
const analytics = await measure('analytics', () => database.rpc('get_dashboard_analytics_v2', {
  p_organization_id: organizationId,
  p_start_date: startDate,
  p_end_date: endDate,
  p_profile_ids: null,
  p_group_id: null,
  p_provider: null,
  p_metric: 'likes',
  p_bucket: null,
}));
const topPosts = await measure('top_posts', () => database.rpc('get_dashboard_top_posts_v2', {
  p_organization_id: organizationId,
  p_start_date: startDate,
  p_end_date: endDate,
  p_profile_ids: null,
  p_group_id: null,
  p_provider: null,
  p_metric: 'likes',
  p_limit: 8,
}));

const report = {
  generatedAt: new Date().toISOString(),
  organizationId,
  range: { startDate, endDate },
  measurements: [bootstrap, analytics, topPosts].map(({ data, ...measurement }) => measurement),
  result: {
    bootstrapProfiles: bootstrap.data?.profiles?.length ?? 0,
    bootstrapGroups: bootstrap.data?.groups?.length ?? 0,
    analyticsBucket: analytics.data?.filters?.bucket ?? null,
    analyticsSelectedProfiles: analytics.data?.coverage?.selected_profiles ?? 0,
    analyticsMetricPoints: analytics.data?.metric_series?.length ?? 0,
    topPosts: topPosts.data?.length ?? 0,
  },
};

console.log(JSON.stringify(report, null, 2));
