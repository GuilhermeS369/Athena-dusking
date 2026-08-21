import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

for (const file of ['.env.local', '.env.worker.deploy', '.env.worker']) {
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2]
        .trim()
        .replace(/^["']|["']$/g, '');
    }
  }
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Credenciais administrativas do Supabase ausentes.');

const database = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data, error, count } = await database
  .from('profile_analytics_refresh_step_events')
  .select(
    'job_id,organization_id,profile_id,step,outcome,error_class,error_code,created_at',
    { count: 'exact' },
  )
  .eq('error_code', '42P10')
  .order('created_at', { ascending: false })
  .limit(1000);

if (error) throw error;

const byDate = {};
const byStep = {};
for (const event of data ?? []) {
  const date = event.created_at.slice(0, 10);
  byDate[date] = (byDate[date] ?? 0) + 1;
  byStep[event.step] = (byStep[event.step] ?? 0) + 1;
}

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  total: count ?? data?.length ?? 0,
  latest: data?.[0] ?? null,
  oldestInSample: data?.at(-1) ?? null,
  byDate,
  byStep,
}, null, 2));
