#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
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

loadEnvFile('.env.local');
loadEnvFile('.env.worker');

const organizationId = process.env.PUBLICATION_TELEMETRY_ORGANIZATION_ID;
const hours = Math.min(Math.max(Number.parseInt(process.env.PUBLICATION_TELEMETRY_HOURS || '24', 10) || 24, 1), 168);
const supabase = createClient(required('NEXT_PUBLIC_SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: organization, error: organizationError } = organizationId
  ? { data: { organization_id: organizationId }, error: null }
  : await supabase.from('publication_items').select('organization_id').limit(1).maybeSingle();
if (organizationError) throw organizationError;
if (!organization?.organization_id) throw new Error('Nenhuma organização com publicações foi encontrada. Defina PUBLICATION_TELEMETRY_ORGANIZATION_ID para validar explicitamente.');

const { data, error } = await supabase.rpc('get_publication_dispatch_telemetry', {
  p_organization_id: organization.organization_id,
  p_hours: hours,
});
if (error) throw error;

console.info(JSON.stringify({
  ok: true,
  organizationId: organization.organization_id,
  windowHours: data?.windowHours,
  windowStart: data?.windowStart,
  cycles: data?.cycles,
  providerCount: Array.isArray(data?.providers) ? data.providers.length : 0,
  errorGroups: Array.isArray(data?.errors) ? data.errors.length : 0,
  alerts: data?.alerts ?? [],
}, null, 2));
