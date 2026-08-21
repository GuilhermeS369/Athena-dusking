#!/usr/bin/env node

import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

loadEnvFile('.env.local');
loadEnvFile('.env.worker.deploy');

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

const supabase = createClient(
  requiredEnv('NEXT_PUBLIC_SUPABASE_URL'),
  requiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const missingItemId = '00000000-0000-0000-0000-000000000000';
const workerId = 'phase5-readonly-smoke';

async function expectMissingItemRpc(name, parameters) {
  const { error } = await supabase.rpc(name, parameters);
  if (!error) throw new Error(`${name} deveria rejeitar UUID inexistente.`);
  if (error.code === 'PGRST202') throw new Error(`${name} não está disponível no cache da API.`);
  if (error.code !== 'P0002') throw error;
  return { available: true, expectedErrorCode: error.code };
}

async function main() {
  const { data: summary, error: summaryError } = await supabase.rpc(
    'get_publication_queue_operational_summary',
    { p_organization_id: null },
  );
  if (summaryError) throw summaryError;

  const checks = {
    operationalSummary: {
      available: true,
      rows: Array.isArray(summary) ? summary.length : 0,
      suspendedRows: Array.isArray(summary)
        ? summary.filter((row) => row.status === 'suspended').length
        : 0,
    },
    onlineBarrier: await expectMissingItemRpc(
      'assert_claimed_publication_profile_online',
      { p_item_id: missingItemId, p_worker_id: workerId },
    ),
    confirmedReconciliation: await expectMissingItemRpc(
      'reconcile_confirmed_publication_item',
      { p_item_id: missingItemId, p_worker_id: workerId, p_meta_media_id: null },
    ),
    creationReconciliation: await expectMissingItemRpc(
      'reconcile_suspended_publication_creation',
      { p_item_id: missingItemId, p_worker_id: workerId, p_creation_id: 'phase5-smoke' },
    ),
  };

  console.log(JSON.stringify({ ok: true, checks }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    code: error?.code ?? null,
    message: error?.message ?? String(error),
  }));
  process.exitCode = 1;
});
