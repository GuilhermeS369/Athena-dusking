#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

for (const filePath of ['.env.local', '.env.worker', '.env.worker.deploy']) {
  if (!fs.existsSync(filePath)) continue;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (process.env[key]) continue;
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

const supabase = createClient(required('NEXT_PUBLIC_SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { autoRefreshToken: false, persistSession: false },
});

const startedAt = Date.now();
const { data, error } = await supabase.rpc('get_bulk_rotation_operational_summary', {
  p_organization_id: process.env.LOAD_TEST_ORGANIZATION_ID || null,
  p_stalled_after_seconds: Number.parseInt(process.env.BULK_STALLED_AFTER_SECONDS || '900', 10),
  p_growth_warning_publications: process.env.BULK_GROWTH_WARNING_PUBLICATIONS || '100000',
});
if (error) throw error;

const report = { queryElapsedMs: Date.now() - startedAt, ...data };
console.info(JSON.stringify(report, null, 2));
if (process.env.BULK_FAIL_ON_CRITICAL === 'true' && (data?.alerts || []).some((alert) => alert.severity === 'critical')) process.exitCode = 2;
