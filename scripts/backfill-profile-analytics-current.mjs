import fs from 'node:fs';
import process from 'node:process';

import { createClient } from '@supabase/supabase-js';

for (const filePath of ['.env.local', '.env.worker']) {
  if (!fs.existsSync(filePath)) continue;
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const separator = rawLine.indexOf('=');
    if (separator <= 0 || rawLine.trim().startsWith('#')) continue;
    const key = rawLine.slice(0, separator).trim();
    if (!process.env[key]) process.env[key] = rawLine.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
  }
}

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
};
const organizationId = required('PROFILE_ANALYTICS_BACKFILL_ORGANIZATION_ID');
const limit = Math.min(Math.max(Number.parseInt(process.env.PROFILE_ANALYTICS_BACKFILL_LIMIT ?? '500', 10) || 500, 1), 2000);
const supabase = createClient(required('NEXT_PUBLIC_SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { autoRefreshToken: false, persistSession: false },
});

let afterProfileId = null;
let totalProcessed = 0;
const batches = [];
do {
  const { data, error } = await supabase.rpc('backfill_profile_analytics_current', {
    p_organization_id: organizationId,
    p_limit: limit,
    p_after_profile_id: afterProfileId,
  });
  if (error) throw error;
  const batch = data?.[0] ?? { processed_count: 0, last_profile_id: null, has_more: false };
  batches.push(batch);
  totalProcessed += batch.processed_count ?? 0;
  afterProfileId = batch.last_profile_id;
  if (!batch.has_more || !afterProfileId) break;
} while (true);

let archiveAfterProfileId = null;
let totalArchived = 0;
const archiveBatches = [];
do {
  const { data, error } = await supabase.rpc('backfill_profile_analytics_current_archives', {
    p_organization_id: organizationId,
    p_limit: Math.min(limit, 1000),
    p_after_profile_id: archiveAfterProfileId,
  });
  if (error) throw error;
  const batch = data?.[0] ?? { processed_count: 0, archived_count: 0, last_profile_id: null, has_more: false };
  archiveBatches.push(batch);
  totalArchived += batch.archived_count ?? 0;
  archiveAfterProfileId = batch.last_profile_id;
  if (!batch.has_more || !archiveAfterProfileId) break;
} while (true);

const { data: parity, error: parityError } = await supabase.rpc('audit_profile_analytics_current_parity', {
  p_organization_id: organizationId,
});
if (parityError) throw parityError;
console.log(JSON.stringify({ organizationId, totalProcessed, batches, totalArchived, archiveBatches, parity }, null, 2));
