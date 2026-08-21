#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

for (const filePath of ['.env.local', '.env.worker.deploy']) {
  if (!fs.existsSync(filePath)) continue;
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const separator = rawLine.indexOf('=');
    if (separator <= 0 || rawLine.trim().startsWith('#')) continue;
    const key = rawLine.slice(0, separator).trim();
    if (process.env[key]) continue;
    process.env[key] = rawLine.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
  }
}

const organizationId = process.argv.find((value) => value.startsWith('--organization-id='))?.split('=')[1];
const requestedBy = process.argv.find((value) => value.startsWith('--requested-by='))?.split('=')[1];
if (!organizationId || !requestedBy) throw new Error('Informe --organization-id e --requested-by.');

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const lockHolder = randomUUID();
const correlationId = randomUUID();
const { data, error } = await supabase.rpc('enqueue_zernio_organization_sync_batch', {
  p_organization_id: organizationId,
  p_requested_by: requestedBy,
  p_lock_holder: lockHolder,
  // O parâmetro explícito desambigua o overload legado de três argumentos no PostgREST.
  p_correlation_id: correlationId,
});
if (error) throw error;
console.log(JSON.stringify({ lockHolder, correlationId, batch: data?.[0] ?? data }, null, 2));
