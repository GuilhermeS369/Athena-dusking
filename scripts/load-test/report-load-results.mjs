#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

loadEnvFile('.env.local');
loadEnvFile('.env.worker');

const organizationId = process.env.LOAD_TEST_ORGANIZATION_ID || null;

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    if (process.env[key]) continue;
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

function createSupabase() {
  return createClient(requiredEnv('NEXT_PUBLIC_SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function main() {
  const supabase = createSupabase();
  const { data, error } = await supabase.rpc('get_publication_queue_operational_summary', {
    p_organization_id: organizationId,
  });
  if (error) throw error;

  const rows = data || [];
  const totals = rows.reduce((summary, row) => {
    summary.total += row.total || 0;
    summary.expiredLeases += row.expired_leases || 0;
    summary.dueRetries += row.due_retries || 0;
    summary.overdue += row.overdue || 0;
    summary.maxLagSeconds = Math.max(summary.maxLagSeconds, row.max_lag_seconds || 0);
    summary.byStatus[row.status] = (summary.byStatus[row.status] || 0) + (row.total || 0);
    return summary;
  }, { total: 0, expiredLeases: 0, dueRetries: 0, overdue: 0, maxLagSeconds: 0, byStatus: {} });

  console.info(JSON.stringify({ checkedAt: new Date().toISOString(), organizationId, totals, rows }, null, 2));
}

main().catch((error) => {
  console.error('[load-test] relatório falhou', error);
  process.exitCode = 1;
});
