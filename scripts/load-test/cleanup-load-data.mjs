#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

loadEnvFile('.env.local');
loadEnvFile('.env.worker');

const loadTestId = requiredEnv('LOAD_TEST_ID');
const organizationId = requiredEnv('LOAD_TEST_ORGANIZATION_ID');

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
  const pattern = `[LOAD TEST ${loadTestId}]%`;
  const { data: batches, error: listError } = await supabase
    .from('publication_batches')
    .select('id')
    .eq('organization_id', organizationId)
    .like('name', pattern);
  if (listError) throw listError;
  const batchIds = (batches || []).map((batch) => batch.id);
  if (!batchIds.length) {
    console.info('[load-test] nenhum lote encontrado para limpeza', { loadTestId, organizationId });
    return;
  }

  const { error: deleteError } = await supabase
    .from('publication_batches')
    .delete()
    .eq('organization_id', organizationId)
    .in('id', batchIds);
  if (deleteError) throw deleteError;
  console.info('[load-test] limpeza concluída', { loadTestId, organizationId, deletedBatches: batchIds.length });
}

main().catch((error) => {
  console.error('[load-test] limpeza falhou', error);
  process.exitCode = 1;
});
