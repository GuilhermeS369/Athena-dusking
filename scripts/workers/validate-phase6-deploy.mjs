#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

for (const filePath of ['.env.local', '.env.worker.deploy']) {
  if (!fs.existsSync(filePath)) continue;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    if (!key || process.env[key]) continue;
    let value = line.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Credenciais do Supabase não encontradas.');

const supabase = createClient(url, key, { auth: { persistSession: false } });
const nonexistentId = '00000000-0000-0000-0000-000000000000';
const { error } = await supabase.rpc('resume_suspended_batch_profile_publications', {
  p_organization_id: nonexistentId,
  p_batch_id: nonexistentId,
  p_profile_id: nonexistentId,
  p_actor_label: 'phase6-schema-smoke',
});

if (!error || error.code !== 'P0002') {
  throw new Error(`Resposta inesperada da RPC: ${error?.code ?? 'sem erro'} ${error?.message ?? ''}`);
}

console.log(JSON.stringify({
  ok: true,
  rpc: 'resume_suspended_batch_profile_publications',
  expectedErrorCode: error.code,
}, null, 2));
